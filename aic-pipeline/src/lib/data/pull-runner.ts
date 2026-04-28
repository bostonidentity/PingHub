import fs from "fs";
import path from "path";
import readline from "readline";
import type { DataPullJob } from "./types";
import type { Registry } from "./job-registry";
import { NDJSON_FILE, OFFSETS_FILE, type Offsets } from "./ndjson-format";

const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_PAGE_SIZE = 5000;
const INDEX_FIELD_MAX_LEN = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract short scalar fields from a record for the browse index. */
function pickIndexFields(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith("_") && k !== "_id") continue;
    if (typeof v === "string" && v.length <= INDEX_FIELD_MAX_LEN) out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** Recursively extract all `_ref` values matching `managed/{type}/{id}` from a record. */
function extractRefs(obj: unknown): string[] {
  const refs: string[] = [];
  if (obj == null || typeof obj !== "object") return refs;
  if (Array.isArray(obj)) {
    for (const item of obj) refs.push(...extractRefs(item));
    return refs;
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec._ref === "string" && rec._ref.startsWith("managed/")) {
    refs.push(rec._ref);
  }
  for (const [key, val] of Object.entries(rec)) {
    if (key === "_ref") continue;
    refs.push(...extractRefs(val));
  }
  return refs;
}

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

/**
 * Stream-read an NDJSON file and rebuild in-memory state from records up to
 * `expectedBytes`. Returns the offsets/index/refs accumulators that match
 * the bytes already on disk. Caller has already truncated the file to
 * `expectedBytes` so any half-written tail is gone.
 */
async function rebuildFromNDJson(
  ndjsonPath: string,
  pickIndexFieldsFn: typeof pickIndexFields,
  extractRefsFn: typeof extractRefs,
): Promise<{
  offsets: Offsets;
  indexEntries: { id: string; f: Record<string, string> }[];
  refsIndex: Record<string, string[]>;
  fetched: number;
  byteLength: number;
}> {
  const offsets: Offsets = {};
  const indexEntries: { id: string; f: Record<string, string> }[] = [];
  const refsIndex: Record<string, string[]> = {};
  let fetched = 0;
  let byteLength = 0;

  if (!fs.existsSync(ndjsonPath)) {
    return { offsets, indexEntries, refsIndex, fetched, byteLength };
  }

  const stream = fs.createReadStream(ndjsonPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let item: Record<string, unknown>;
    try { item = JSON.parse(line); } catch { continue; }
    const id = typeof item._id === "string"
      ? item._id
      : typeof item.id === "string"
        ? item.id as string
        : String(fetched + 1);
    offsets[id] = byteLength;
    indexEntries.push({ id, f: pickIndexFieldsFn(item) });
    const r = extractRefsFn(item);
    if (r.length > 0) refsIndex[id] = r;
    fetched++;
    byteLength += Buffer.byteLength(line, "utf-8") + 1; // +1 for the newline
  }
  return { offsets, indexEntries, refsIndex, fetched, byteLength };
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
  /**
   * Page size for the `_pageSize` query param. Order of precedence at the
   * call site (route handler resolves these into a single number):
   *   1. Environment.pageSize from environments.json
   *   2. process.env.DATA_PULL_PAGE_SIZE
   *   3. DEFAULT_PAGE_SIZE (5000)
   */
  pageSize?: number;
}

export async function runPull(opts: RunPullOpts): Promise<void> {
  const {
    job, registry, envsRoot, envVars,
    mintToken, fetchFn = fetch, signal,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    pageSize = DEFAULT_PAGE_SIZE,
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

    let indexEntries: { id: string; f: Record<string, string> }[] = [];
    let refsIndex: Record<string, string[]> = {};
    let offsets: Offsets = {};

    const ndjsonPath = path.join(typePullingDir, NDJSON_FILE);

    let cookie: string | null = null;
    let total: number | null = null;
    let fetched = 0;
    let bytesWritten = 0;
    let typeFailed = false;

    // Resume detection: per-type progress already has cookie/byteLength from
    // the prior interrupted run. If `byteLength > 0`, truncate the existing
    // NDJSON to that size (drops any half-written tail) and rebuild
    // in-memory state from the kept bytes.
    const persistedProgress = job.progress.find((p) => p.type === type);
    const isResuming = !!persistedProgress
      && typeof persistedProgress.byteLength === "number"
      && persistedProgress.byteLength > 0
      && fs.existsSync(ndjsonPath);

    if (isResuming) {
      fs.truncateSync(ndjsonPath, persistedProgress!.byteLength!);
      const rebuilt = await rebuildFromNDJson(ndjsonPath, pickIndexFields, extractRefs);
      offsets = rebuilt.offsets;
      indexEntries = rebuilt.indexEntries;
      refsIndex = rebuilt.refsIndex;
      fetched = rebuilt.fetched;
      bytesWritten = rebuilt.byteLength;
      cookie = persistedProgress!.cookie ?? null;
      total = persistedProgress!.total ?? null;
    } else {
      total = await preflightCount(type, token);
      if (total !== null) {
        registry.updateProgress(job.id, type, { fetched: 0, total });
      }
    }

    const ndjsonStream = fs.createWriteStream(ndjsonPath, { flags: "a" });
    ndjsonStream.on("error", () => { /* swallow post-destroy ENOENT */ });

    pages:
    while (true) {
      if (signal.aborted) { ndjsonStream.destroy(); break outer; }

      const url = new URL(`${tenantUrl}/openidm/managed/${type}`);
      url.searchParams.set("_queryFilter", "true");
      url.searchParams.set("_pageSize", String(pageSize));
      if (cookie) url.searchParams.set("_pagedResultsCookie", cookie);

      let attempt = 0;
      let success = false;
      let refreshedThisPage = false;

      while (attempt <= MAX_RETRIES) {
        if (signal.aborted) { ndjsonStream.destroy(); break outer; }
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
            if (signal.aborted) { ndjsonStream.destroy(); break outer; }
            const id = typeof item._id === "string"
              ? item._id
              : typeof item.id === "string"
                ? item.id as string
                : String(fetched + 1);
            if (id in offsets) continue; // dedupe on resume
            const line = JSON.stringify(item) + "\n";
            offsets[id] = bytesWritten;
            ndjsonStream.write(line);
            bytesWritten += Buffer.byteLength(line, "utf-8");
            indexEntries.push({ id, f: pickIndexFields(item) });
            const itemRefs = extractRefs(item);
            if (itemRefs.length > 0) refsIndex[id] = itemRefs;
            fetched++;
          }
          // Only accept a non-negative total. Default tenant behavior returns
          // -1 ("unknown"); accepting it would make the UI show `N / -1`.
          if (typeof data.totalPagedResults === "number" && data.totalPagedResults >= 0) {
            total = data.totalPagedResults;
          }

          // Drain the write stream so byteLength accurately reflects what's on disk.
          if (ndjsonStream.writableNeedDrain) {
            await new Promise<void>((resolve) => ndjsonStream.once("drain", resolve));
          }

          cookie = data.pagedResultsCookie ?? null;
          registry.updateProgress(job.id, type, {
            fetched,
            total,
            cookie,
            byteLength: bytesWritten,
          });
          success = true;
          break;
        } catch (err) {
          if (signal.aborted) { ndjsonStream.destroy(); break outer; }
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

    if (signal.aborted) {
      ndjsonStream.destroy();
      break;
    }

    if (typeFailed) {
      anyFailed = true;
      ndjsonStream.destroy();
      fs.rmSync(typePullingDir, { recursive: true, force: true });
      continue;
    }

    // Close the NDJSON stream and flush before the atomic swap.
    await new Promise<void>((resolve, reject) => {
      ndjsonStream.end((err: NodeJS.ErrnoException | null | undefined) =>
        err ? reject(err) : resolve(),
      );
    });

    // Atomic swap: prev → .prev-<job>-<type>, new → current, delete prev.
    // Uses renameWithRetry so transient Windows file-handle locks don't
    // fail the pull after we've already fetched every record.
    // Wrapped in try/catch so a persistent lock doesn't leave the job
    // stuck as "running" forever (which would block all future pulls).
    try {
      const currentDir = path.join(envsRoot, job.env, "managed-data", type);
      const backupDir = path.join(envsRoot, job.env, "managed-data", `.prev-${job.id}-${type}`);
      if (fs.existsSync(currentDir)) await renameWithRetry(currentDir, backupDir);
      await renameWithRetry(typePullingDir, currentDir);
      const pulledAt = Date.now();
      fs.writeFileSync(
        path.join(currentDir, "_manifest.json"),
        JSON.stringify({ type, pulledAt, count: fetched, jobId: job.id }, null, 2),
      );
      fs.writeFileSync(
        path.join(currentDir, "_index.json"),
        JSON.stringify(indexEntries),
      );
      fs.writeFileSync(
        path.join(currentDir, "_refs.json"),
        JSON.stringify(refsIndex),
      );
      fs.writeFileSync(
        path.join(currentDir, OFFSETS_FILE),
        JSON.stringify(offsets),
      );
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });

      registry.updateProgress(job.id, type, { status: "done", fetched, total });
    } catch (swapErr) {
      anyFailed = true;
      registry.updateProgress(job.id, type, {
        status: "failed",
        error: (swapErr as Error).message,
      });
      fs.rmSync(typePullingDir, { recursive: true, force: true });
    }
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
