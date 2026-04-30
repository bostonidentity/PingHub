import fs from "fs";
import path from "path";
import readline from "readline";
import v8 from "v8";
import type { DataPullJob } from "./types";
import type { Registry } from "./job-registry";
import { NDJSON_FILE } from "./ndjson-format";
import { openIndexDb } from "./index-db";
import { buildIndexFromNDJson } from "./index-builder";
import type Database from "better-sqlite3";

const MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_PAGE_SIZE = 50000;
const INDEX_FIELD_MAX_LEN = 200;

/**
 * Heap-pressure auto-suspend threshold (fraction of V8's heap_size_limit).
 *
 * Next.js's dev-server memory watchdog warns at ~50% used and restarts at
 * higher pressure. By suspending ourselves at 70% we (a) finalize the
 * current type's cookie/byteLength to disk, (b) preserve the staging dir,
 * and (c) free our in-process accumulators (refsIndex, etc.) before the
 * watchdog can decide to kill the process. The user just clicks Resume.
 *
 * Override with DATA_PULL_HEAP_SUSPEND_FRACTION (e.g. 0.6 for earlier
 * suspend, 0.85 for more aggressive use of available heap).
 */
const DEFAULT_HEAP_SUSPEND_FRACTION = 0.7;

function getHeapSuspendFraction(): number {
  const raw = process.env.DATA_PULL_HEAP_SUSPEND_FRACTION;
  if (!raw) return DEFAULT_HEAP_SUSPEND_FRACTION;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_HEAP_SUSPEND_FRACTION;
}

/**
 * Returns true when V8's used heap is above the configured fraction of
 * heap_size_limit. Cheap (~microseconds) — safe to call every page.
 */
function isHeapUnderPressure(fraction: number): boolean {
  const { heap_size_limit, used_heap_size } = v8.getHeapStatistics();
  if (!heap_size_limit) return false;
  return used_heap_size / heap_size_limit >= fraction;
}


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
 * Stream-read an NDJSON file and rebuild only the in-memory state the resume
 * path actually needs:
 *   - `seenIds`  — to dedupe records already on disk against records returned
 *                 by the next page (cookie-based pagination should not repeat,
 *                 but defensively we still skip duplicates).
 *   - `refsIndex` — accumulated across pages, serialized to `_refs.json` when
 *                   the type completes.
 *   - `fetched` / `byteLength` — totals so the runner picks up the right
 *                                ndjson byte offset and progress count.
 *
 * Earlier versions also built a full `offsets` map and a list of
 * `indexEntries` for every record on disk. Both were either unused by the
 * caller (indexEntries) or used only to seed `seenIds` (offsets), so on a
 * resume of a 10M-record type they wasted ~1.5 GB of heap before the resume
 * even fetched its first new page. Removed.
 *
 * Caller has already truncated the file to the bytes it intends to keep.
 */
async function rebuildFromNDJson(
  ndjsonPath: string,
  extractRefsFn: typeof extractRefs,
): Promise<{
  seenIds: Set<string>;
  refsIndex: Record<string, string[]>;
  fetched: number;
  byteLength: number;
}> {
  const seenIds = new Set<string>();
  const refsIndex: Record<string, string[]> = {};
  let fetched = 0;
  let byteLength = 0;

  if (!fs.existsSync(ndjsonPath)) {
    return { seenIds, refsIndex, fetched, byteLength };
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
    seenIds.add(id);
    const r = extractRefsFn(item);
    if (r.length > 0) refsIndex[id] = r;
    fetched++;
    byteLength += Buffer.byteLength(line, "utf-8") + 1; // +1 for the newline
  }
  return { seenIds, refsIndex, fetched, byteLength };
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
   *   3. DEFAULT_PAGE_SIZE (50000)
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
  const heapSuspendFraction = getHeapSuspendFraction();
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
    // Skip types already completed in a prior run (resume after interrupt
    // or manual suspend). Their data is in the canonical dir and the
    // staging dir is gone, so attempting to "resume" would fail with
    // "resume staging file missing".
    const existingProgress = job.progress.find((p) => p.type === type);
    if (existingProgress?.status === "done") continue;
    registry.updateProgress(job.id, type, { status: "running" });

    const typePullingDir = path.join(pullingRoot, type);
    fs.mkdirSync(typePullingDir, { recursive: true });

    let refsIndex: Record<string, string[]> = {};
    /** Bytes already written to data.ndjson — used as the offset for the next record. */
    let bytesWritten = 0;
    /**
     * Set of ids already inserted, used ONLY to dedupe rows already on disk
     * from a prior interrupted run when resuming. On a fresh pull this stays
     * `null` — the tenant doesn't repeat ids across pages, and SQLite's
     * `INSERT OR REPLACE` would absorb any anomaly anyway. Holding 10M+ UUID
     * strings here was tripping Next.js's "approaching memory threshold"
     * watchdog on very large types (alpha_user, etc.).
     */
    let seenIds: Set<string> | null = null;

    const ndjsonPath = path.join(typePullingDir, NDJSON_FILE);

    let cookie: string | null = null;
    let total: number | null = null;
    let fetched = 0;
    let typeFailed = false;

    // Resume detection: per-type progress already has cookie/byteLength from
    // the prior interrupted run. If `byteLength > 0`, truncate the existing
    // NDJSON to that size (drops any half-written tail) and rebuild
    // in-memory state from the kept bytes.
    const persistedProgress = job.progress.find((p) => p.type === type);
    const wantsResume = !!persistedProgress
      && typeof persistedProgress.byteLength === "number"
      && persistedProgress.byteLength > 0;
    const isResuming = wantsResume && fs.existsSync(ndjsonPath);

    if (wantsResume && !isResuming) {
      // The job state says "resume from byte X with cookie Y", but the
      // staging file is gone. We can't safely restart from the cookie
      // (records before byte X would be lost), and we shouldn't silently
      // re-fetch from page 1 either (wasted hours of tenant traffic).
      // Mark the type failed with a clear message so the user knows.
      registry.updateProgress(job.id, type, {
        status: "failed",
        error: "resume staging file missing — please start a fresh pull",
      });
      anyFailed = true;
      continue;
    }

    if (isResuming) {
      fs.truncateSync(ndjsonPath, persistedProgress!.byteLength!);
      const rebuilt = await rebuildFromNDJson(ndjsonPath, extractRefs);
      refsIndex = rebuilt.refsIndex;
      seenIds = rebuilt.seenIds;
      bytesWritten = rebuilt.byteLength;
      fetched = rebuilt.fetched;
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

    const indexDb: Database.Database = openIndexDb(typePullingDir);
    try {
      indexDb.prepare("DELETE FROM records").run(); // resume case — idempotent rebuild
      const insertStmt = indexDb.prepare(
        "INSERT OR REPLACE INTO records(id, ord, offset, length, fields_json, searchable) VALUES (?, ?, ?, ?, ?, ?)",
      );
      let nextOrd = 0; // restarts from 0; the post-pull buildIndexFromNDJson re-numbers from disk truth

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
              const backoff = [5000, 10000, 20000, 40000, 60000][attempt] ?? 60000;
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
              // If we were resuming with a persisted cookie and the tenant
              // rejected the request with a 4xx, the cookie is most likely
              // stale (AIC's _pagedResultsCookie isn't documented as durable
              // across long gaps). Surface a clear message so the user knows
              // to start a fresh pull rather than keep retrying.
              const isResumeFailure = isResuming && cookie && res.status >= 400 && res.status < 500;
              let body = "";
              if (isResumeFailure) {
                try { body = await res.text(); } catch { body = ""; }
              }
              const errorMsg = isResumeFailure
                ? `paged results cookie expired — please start a fresh pull (HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""})`
                : `HTTP ${res.status}`;
              registry.updateProgress(job.id, type, {
                status: "failed",
                error: errorMsg,
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
            // Build the page's index rows first so the SQLite insert can run in
            // a single transaction (~50× faster than autocommit on better-sqlite3).
            interface PageRow { id: string; ord: number; offset: number; length: number; fields_json: string; searchable: string; line: string; refs: string[]; }
            const pageRows: PageRow[] = [];
            for (const item of items) {
              if (signal.aborted) { ndjsonStream.destroy(); break outer; }
              const id = typeof item._id === "string"
                ? item._id
                : typeof item.id === "string"
                  ? item.id as string
                  : String(fetched + 1);
              if (seenIds && seenIds.has(id)) continue; // dedupe on resume
              const lineStr = JSON.stringify(item);
              const lineLen = Buffer.byteLength(lineStr, "utf-8");
              const fields = pickIndexFields(item);
              pageRows.push({
                id,
                ord: nextOrd,
                offset: bytesWritten,
                length: lineLen,
                fields_json: JSON.stringify(fields),
                searchable: Object.values(fields).join(" ").toLowerCase(),
                line: lineStr,
                refs: extractRefs(item),
              });
              if (seenIds) seenIds.add(id);
              nextOrd++;
              bytesWritten += lineLen + 1; // +1 for newline
            }
            // NDJSON write goes outside the transaction (different file/handle).
            for (const r of pageRows) ndjsonStream.write(r.line + "\n");
            // SQLite inserts in one transaction.
            const insertPage = indexDb.transaction((batch: PageRow[]) => {
              for (const r of batch) {
                insertStmt.run(r.id, r.ord, r.offset, r.length, r.fields_json, r.searchable);
              }
            });
            insertPage(pageRows);
            for (const r of pageRows) {
              if (r.refs.length > 0) refsIndex[r.id] = r.refs;
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

        // Memory-pressure auto-suspend. Cookie + byteLength are now on disk
        // (just persisted in the success branch above), so it's safe to
        // bail out cleanly: the post-loop cleanup will see job.status ===
        // "suspending", preserve the staging dir, and finalize as
        // "suspended". The user clicks Resume to continue from here.
        if (isHeapUnderPressure(heapSuspendFraction)) {
          const stats = v8.getHeapStatistics();
          const usedMb = Math.round(stats.used_heap_size / 1024 / 1024);
          const limitMb = Math.round(stats.heap_size_limit / 1024 / 1024);
          registry.setJobStatus(
            job.id,
            "suspending",
            `auto-suspended at ${usedMb} MB / ${limitMb} MB heap (${Math.round(heapSuspendFraction * 100)}% threshold) — click Resume to continue`,
          );
          ndjsonStream.destroy();
          if (indexDb.open) indexDb.close();
          break outer;
        }
      }

      if (signal.aborted) {
        ndjsonStream.destroy();
        // Close indexDb before the outer-for break — leaving it open would
        // hold a Windows file lock on the staging dir's index.sqlite, blocking
        // the post-loop cleanup `fs.rmSync(pullingRoot)` (EPERM/EACCES).
        if (indexDb.open) indexDb.close();
        break;
      }

      if (typeFailed) {
        anyFailed = true;
        ndjsonStream.destroy();
        // CRITICAL on Windows: close the SQLite handle before rm-rf'ing the
        // staging dir, otherwise rmSync fails with EPERM because index.sqlite
        // is still open.
        if (indexDb.open) indexDb.close();
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
      //
      // CRITICAL: close the SQLite handle on `index.sqlite` BEFORE renaming
      // `typePullingDir`. On Windows, an open file handle inside a directory
      // prevents the directory itself from being renamed (EPERM/EACCES) — this
      // is what caused the "EPERM: operation not permitted, rename ..." failures
      // observed in production. The post-swap `buildIndexFromNDJson` opens its
      // own connection on the renamed path, so closing here is safe.
      indexDb.close();
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
          path.join(currentDir, "_refs.json"),
          JSON.stringify(refsIndex),
        );
        // Rebuild SQLite from the now-canonical data.ndjson. Cheap because reading
        // is sequential and inserts go in one transaction. Also covers the resume
        // case where rebuilt-but-not-inserted rows existed at the start of the run.
        await buildIndexFromNDJson(currentDir, pickIndexFields);
        // Mirror manifest pulledAt into meta for parity.
        const finalDb = openIndexDb(currentDir);
        finalDb.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('pulledAt', ?)").run(String(pulledAt));
        finalDb.close();
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
    } finally {
      if (indexDb.open) indexDb.close();
    }
  }

  // Detect manual suspend: the suspend endpoint mutates job.status to
  // "suspending" and then aborts the controller. Because `job` is the same
  // reference held by the registry, we observe the status change here.
  // On suspend we KEEP the staging dir intact so the resume can pick up
  // from the persisted per-type cookie + byteLength.
  const isSuspending = job.status === "suspending";

  // Cleanup any lingering pulling dir (aborted or failed). Skipped when
  // suspending so the resume can re-open the staging files.
  if (!isSuspending && fs.existsSync(pullingRoot)) {
    fs.rmSync(pullingRoot, { recursive: true, force: true });
  }

  if (isSuspending) {
    registry.setJobStatus(job.id, "suspended");
  } else if (signal.aborted) {
    registry.setJobStatus(job.id, "aborted");
  } else if (anyFailed) {
    registry.setJobStatus(job.id, "failed", "one or more types failed");
  } else {
    registry.setJobStatus(job.id, "completed");
  }
}
