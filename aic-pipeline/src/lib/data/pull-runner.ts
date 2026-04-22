import fs from "fs";
import path from "path";
import type { DataPullJob } from "./types";
import type { Registry } from "./job-registry";

const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 3000;
const PAGE_SIZE = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rename with retry for transient Windows locks.
 *
 * On Windows, fs.rename() can fail with EPERM / EACCES / EBUSY when a
 * file watcher (Next.js/turbopack, VS Code, Windows Search Indexer) or
 * antivirus briefly holds a handle on a file inside src or dst — very
 * common right after we've written thousands of JSON records into the
 * staging dir. POSIX doesn't hit this; we just retry with backoff so
 * the locks clear. ENOTEMPTY covers the Windows variant "dst exists
 * and is non-empty".
 */
async function renameWithRetry(src: string, dst: string, maxAttempts = 5): Promise<void> {
  let lastErr: unknown = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY" && code !== "ENOTEMPTY") throw err;
      lastErr = err;
      await sleep(100 * Math.pow(2, i)); // 100, 200, 400, 800, 1600 ms
    }
  }
  throw lastErr;
}

export interface RunPullOpts {
  job: DataPullJob;
  registry: Registry;
  envsRoot: string;
  envVars: Record<string, string>;
  mintToken: (envVars: Record<string, string>) => Promise<string>;
  fetchFn?: typeof fetch;
  signal: AbortSignal;
  retryDelayMs?: number;
  /**
   * Optional preflight count source. Returns the total records expected for
   * a type, or null if unknown. Default implementation queries the tenant
   * with _countPolicy=EXACT. Tests typically pass a no-op to avoid having
   * to mock the preflight HTTP call.
   */
  preflightCount?: (type: string, token: string) => Promise<number | null>;
}

export async function runPull(opts: RunPullOpts): Promise<void> {
  const {
    job, registry, envsRoot, envVars,
    mintToken, fetchFn = fetch, signal,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = opts;

  const tenantUrl = envVars.TENANT_BASE_URL ?? "";
  const pullingRoot = path.join(envsRoot, job.env, "managed-data", `.pulling-${job.id}`);
  let token: string;

  try {
    token = await mintToken(envVars);
  } catch (e) {
    registry.setJobStatus(job.id, "failed", (e as Error).message);
    return;
  }

  registry.setJobStatus(job.id, "running");

  let anyFailed = false;

  // Preflight: ask AIC for a count before paginating, so the progress bar
  // renders a real denominator from the first update. Default tenant behavior
  // returns totalPagedResults = -1 (cheap, no count). EXACT is authoritative
  // but expensive; some types (audit-like / very large) reject it or still
  // return -1. ESTIMATE is much cheaper and usually honored. Try EXACT, fall
  // back to ESTIMATE; give up on null if both yield no count.
  const preflightCount = opts.preflightCount ?? defaultPreflightCount;

  async function tryCount(type: string, bearer: string, policy: "EXACT" | "ESTIMATE"): Promise<number | null> {
    const url = new URL(`${tenantUrl}/openidm/managed/${type}`);
    url.searchParams.set("_queryFilter", "true");
    url.searchParams.set("_countPolicy", policy);
    url.searchParams.set("_pageSize", "1");
    try {
      let res = await fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${bearer}` },
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        token = await mintToken(envVars);
        res = await fetchFn(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
      }
      if (!res.ok) return null;
      const data = await res.json() as { totalPagedResults?: number };
      return typeof data.totalPagedResults === "number" && data.totalPagedResults >= 0
        ? data.totalPagedResults
        : null;
    } catch {
      return null;
    }
  }

  async function defaultPreflightCount(type: string, bearer: string): Promise<number | null> {
    const exact = await tryCount(type, bearer, "EXACT");
    if (exact !== null) return exact;
    return tryCount(type, bearer, "ESTIMATE");
  }

  outer:
  for (const type of job.types) {
    if (signal.aborted) break;
    registry.updateProgress(job.id, type, { status: "running" });

    const typePullingDir = path.join(pullingRoot, type);
    fs.mkdirSync(typePullingDir, { recursive: true });

    let cookie: string | null = null;
    let total: number | null = await preflightCount(type, token);
    let fetched = 0;
    let typeFailed = false;
    if (total !== null) {
      registry.updateProgress(job.id, type, { fetched: 0, total });
    }

    pages:
    while (true) {
      if (signal.aborted) break outer;

      const url = new URL(`${tenantUrl}/openidm/managed/${type}`);
      url.searchParams.set("_queryFilter", "true");
      url.searchParams.set("_pageSize", String(PAGE_SIZE));
      if (cookie) url.searchParams.set("_pagedResultsCookie", cookie);

      let attempt = 0;
      let success = false;
      let refreshedThisPage = false;

      while (attempt <= MAX_RETRIES) {
        if (signal.aborted) break outer;
        try {
          const res = await fetchFn(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal,
          });

          if ((res.status === 401 || res.status === 403) && !refreshedThisPage) {
            token = await mintToken(envVars);
            refreshedThisPage = true;
            continue; // same attempt count
          }

          if (res.status === 429) {
            const backoff = [5000, 10000, 20000][attempt] ?? 20000;
            attempt++;
            if (attempt > MAX_RETRIES) break;
            await sleep(backoff);
            continue;
          }

          if (res.status >= 500) {
            attempt++;
            if (attempt > MAX_RETRIES) break;
            await sleep(retryDelayMs);
            continue;
          }

          if (!res.ok) {
            registry.updateProgress(job.id, type, {
              status: "failed",
              error: `HTTP ${res.status}`,
            });
            typeFailed = true;
            break pages;
          }

          const data = await res.json() as {
            result?: Record<string, unknown>[];
            pagedResultsCookie?: string | null;
            totalPagedResults?: number;
          };

          const items = data.result ?? [];
          for (const item of items) {
            if (signal.aborted) break outer;
            const id = typeof item._id === "string"
              ? item._id
              : typeof item.id === "string"
              ? item.id as string
              : String(fetched + 1);
            fs.writeFileSync(path.join(typePullingDir, `${id}.json`), JSON.stringify(item, null, 2));
            fetched++;
          }
          // Only accept a non-negative total. Default tenant behavior returns
          // -1 ("unknown"); accepting it would make the UI show `N / -1`.
          if (typeof data.totalPagedResults === "number" && data.totalPagedResults >= 0) {
            total = data.totalPagedResults;
          }

          registry.updateProgress(job.id, type, { fetched, total });

          cookie = data.pagedResultsCookie ?? null;
          success = true;
          break;
        } catch (err) {
          if (signal.aborted) break outer;
          attempt++;
          if (attempt > MAX_RETRIES) {
            registry.updateProgress(job.id, type, {
              status: "failed",
              error: (err as Error).message,
            });
            typeFailed = true;
            break pages;
          }
          await sleep(retryDelayMs);
        }
      }

      if (!success) {
        registry.updateProgress(job.id, type, {
          status: "failed",
          error: "max retries exceeded",
        });
        typeFailed = true;
        break;
      }
      if (!cookie) break; // last page
    }

    if (signal.aborted) break;

    if (typeFailed) {
      anyFailed = true;
      fs.rmSync(typePullingDir, { recursive: true, force: true });
      continue;
    }

    // Atomic swap: prev → .prev-<job>-<type>, new → current, delete prev.
    // Uses renameWithRetry so transient Windows file-handle locks don't
    // fail the pull after we've already fetched every record.
    const currentDir = path.join(envsRoot, job.env, "managed-data", type);
    const backupDir = path.join(envsRoot, job.env, "managed-data", `.prev-${job.id}-${type}`);
    if (fs.existsSync(currentDir)) await renameWithRetry(currentDir, backupDir);
    await renameWithRetry(typePullingDir, currentDir);
    fs.writeFileSync(
      path.join(currentDir, "_manifest.json"),
      JSON.stringify({ type, pulledAt: Date.now(), count: fetched, jobId: job.id }, null, 2),
    );
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });

    registry.updateProgress(job.id, type, { status: "done", fetched, total });
  }

  // Cleanup any lingering pulling dir (aborted or failed).
  if (fs.existsSync(pullingRoot)) {
    fs.rmSync(pullingRoot, { recursive: true, force: true });
  }

  if (signal.aborted) {
    registry.setJobStatus(job.id, "aborted");
  } else if (anyFailed) {
    registry.setJobStatus(job.id, "failed", "one or more types failed");
  } else {
    registry.setJobStatus(job.id, "completed");
  }
}
