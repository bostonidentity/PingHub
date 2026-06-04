import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { fetchLogPage, paceDelayMs, isVolumeQuota429, VOLUME_QUOTA_MESSAGE, AUTO_BUMP_MS, MAX_BUMP_MS } from "@/lib/logs/log-fetch";
import { analyzeJourneyHistory, type RawAuthEvent } from "./journey-history";
import { stagingPath as stagingPathFor, reportPath as reportPathFor } from "./journey-report-paths";
import type { JourneyReportJob } from "./journey-report-types";
import type { JourneyReportRegistry } from "./journey-report-registry";

const JOURNEY_SOURCE = "am-authentication";
const MAX_PAGES = 200; // safety net against pathological loops
const DEFAULT_HEAP_SUSPEND_FRACTION = 0.7;

// AIC's queryFilter is finicky with `eq` on /payload/eventName, so narrow with
// `co` (contains) and re-filter client-side — same as the synchronous route.
const BROAD_FILTER =
  '(/payload/eventName co "AM-TREE-LOGIN-") or (/payload/eventName co "AM-NODE-LOGIN-COMPLETED")';
const WANTED_EVENT_NAMES = new Set([
  "AM-TREE-LOGIN-INITIATED",
  "AM-TREE-LOGIN-COMPLETED",
  "AM-NODE-LOGIN-COMPLETED",
]);

function heapUnderPressure(fraction: number): boolean {
  const { heap_size_limit, used_heap_size } = v8.getHeapStatistics();
  if (!heap_size_limit) return false;
  return used_heap_size / heap_size_limit >= fraction;
}

/** Abort-aware sleep: resolves immediately if the signal is/becomes aborted. */
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
  });

/** Match a treeName substring against the two payload fields the analyzer reads. */
function matchesTreeName(payload: unknown, treeFilterLc: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const direct = typeof p.treeName === "string" ? p.treeName.toLowerCase() : "";
  if (direct.includes(treeFilterLc)) return true;
  const entries = p.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    const info = (entries[0] as Record<string, unknown>)?.info;
    const t = info && typeof info === "object" && typeof (info as Record<string, unknown>).treeName === "string"
      ? ((info as Record<string, unknown>).treeName as string).toLowerCase() : "";
    if (t.includes(treeFilterLc)) return true;
  }
  return false;
}

/** Keep only events whose transaction touched the filtered tree (companion events included). */
function applyTreeFilter(events: RawAuthEvent[], treeName?: string): RawAuthEvent[] {
  const lc = treeName?.trim().toLowerCase();
  if (!lc) return events;
  const keep = new Set<string>();
  for (const e of events) {
    if (!matchesTreeName(e.payload, lc)) continue;
    if (typeof e.payload === "object" && e.payload !== null) {
      const t = (e.payload as Record<string, unknown>).transactionId;
      if (typeof t === "string") keep.add(t);
    }
  }
  return events.filter((e) => {
    if (typeof e.payload !== "object" || e.payload === null) return false;
    const t = (e.payload as Record<string, unknown>).transactionId;
    return typeof t === "string" && keep.has(t);
  });
}

function readStaging(file: string): RawAuthEvent[] {
  if (!fs.existsSync(file)) return [];
  const out: RawAuthEvent[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as RawAuthEvent); } catch { /* skip a torn line */ }
  }
  return out;
}

export interface RunJourneyReportOpts {
  job: JourneyReportJob;
  registry: JourneyReportRegistry;
  /** `ENVIRONMENTS_DIR/{env}/journey-reports`. */
  reportRoot: string;
  tenantBaseUrl: string;
  apiKey: string;
  apiSecret: string;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowMs?: () => number;
  heapPressureFn?: () => boolean;
}

/**
 * Page `am-authentication` from AIC into a per-job staging file, then analyze it
 * into a report. Mirrors the log pull: 429 retry/backoff (via fetchLogPage),
 * cookie + byteLength persisted per page for resume, adaptive pacing, heap-
 * pressure auto-suspend, and a per-source-equivalent failure that still reaches
 * a terminal state instead of hanging "running".
 */
export async function runJourneyReport(opts: RunJourneyReportOpts): Promise<void> {
  const {
    job, registry, reportRoot, tenantBaseUrl, apiKey, apiSecret, signal,
    fetchFn = fetch,
    sleepFn = defaultSleep,
    nowMs = () => Date.now(),
    heapPressureFn = () => heapUnderPressure(DEFAULT_HEAP_SUSPEND_FRACTION),
  } = opts;

  const base = tenantBaseUrl.replace(/\/+$/, "");
  const headers = { "x-api-key": apiKey, "x-api-secret": apiSecret };
  const stagePath = stagingPathFor(reportRoot, job.id);
  const repPath = reportPathFor(reportRoot, job.id);
  fs.mkdirSync(path.dirname(stagePath), { recursive: true });

  const finalizeAborted = () => {
    const current = registry.getJob(job.id);
    registry.setJobStatus(job.id, current?.status === "suspending" ? "suspended" : "aborted");
  };
  if (signal.aborted) { finalizeAborted(); return; }
  registry.setJobStatus(job.id, "running");

  const { from, to, treeName, maxEvents } = job.params;
  const p = job.progress;

  // Resume from a persisted cursor, or start fresh. byteLength truncation drops
  // any half-written tail so the staging file holds only fully-persisted pages.
  const wantsResume = typeof p.byteLength === "number" && p.byteLength > 0 && fs.existsSync(stagePath);
  let cookie: string | undefined;
  let rawFetched: number;
  let matched: number;
  let pages: number;
  let truncated: boolean;
  let byteLength: number;
  const eventNameCounts = new Map<string, number>();
  if (wantsResume) {
    fs.truncateSync(stagePath, p.byteLength!);
    cookie = p.cookie ?? undefined;
    rawFetched = p.rawFetched;
    matched = p.matched;
    pages = p.page;
    truncated = p.truncated ?? false;
    byteLength = p.byteLength!;
    for (const [k, v] of Object.entries(p.eventNameCounts ?? {})) eventNameCounts.set(k, v);
  } else {
    fs.writeFileSync(stagePath, "");
    cookie = undefined; rawFetched = 0; matched = 0; pages = 0; truncated = false; byteLength = 0;
  }

  // Adaptive inter-page pacing floor: each throughput 429 raises it (mirrors log pull).
  let bumpFloorMs = 0;
  const onThrottle = () => { bumpFloorMs = Math.min(MAX_BUMP_MS, bumpFloorMs + AUTO_BUMP_MS); };

  let suspended = false;
  let failed = false;

  try {
    while (pages < MAX_PAGES && matched < maxEvents && !truncated) {
      if (signal.aborted) break;
      pages++;

      const params = new URLSearchParams({
        source: JOURNEY_SOURCE,
        beginTime: from,
        endTime: to,
        _queryFilter: BROAD_FILTER,
        ...(cookie ? { _pagedResultsCookie: cookie } : {}),
      });
      const url = `${base}/monitoring/logs?${params}`;

      const res = await fetchLogPage(url, headers, { fetchFn, signal, sleepFn, onThrottle });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const error = res.status === 429 && isVolumeQuota429(body)
          ? VOLUME_QUOTA_MESSAGE
          : `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
        registry.setJobStatus(job.id, "failed", error);
        failed = true;
        break;
      }

      const data = (await res.json()) as {
        result?: Array<{ timestamp?: string; payload?: unknown }>;
        // CREST asymmetry: request is `_pagedResultsCookie`, response is `pagedResultsCookie`.
        pagedResultsCookie?: string | null;
      };
      const pageArr = Array.isArray(data.result) ? data.result : [];
      rawFetched += pageArr.length;

      let lines = "";
      let lastTs: string | undefined;
      for (const r of pageArr) {
        if (matched >= maxEvents) { truncated = true; break; }
        if (!r.timestamp) continue;
        const payload = r.payload ?? {};
        if (typeof payload !== "object" || payload === null) continue;
        const evName = (payload as Record<string, unknown>).eventName;
        if (typeof evName === "string") {
          eventNameCounts.set(evName, (eventNameCounts.get(evName) ?? 0) + 1);
        }
        if (typeof evName !== "string" || !WANTED_EVENT_NAMES.has(evName)) continue;
        lines += JSON.stringify({ timestamp: r.timestamp, payload }) + "\n";
        matched++;
        lastTs = r.timestamp;
      }
      if (lines) {
        fs.appendFileSync(stagePath, lines);
        byteLength += Buffer.byteLength(lines);
      }

      cookie = truncated ? undefined : (data.pagedResultsCookie ?? undefined);
      registry.updateProgress(job.id, {
        page: pages, rawFetched, matched, cookie: cookie ?? null, byteLength,
        lastTimestamp: lastTs, truncated, eventNameCounts: Object.fromEntries(eventNameCounts),
      });

      if (truncated || !cookie) break;

      // Pace under the rate limit (header-based + adaptive floor), then check heap.
      const wait = Math.max(paceDelayMs(res, nowMs()), bumpFloorMs);
      if (wait > 0) await sleepFn(wait, signal);
      if (heapPressureFn()) {
        registry.setJobStatus(job.id, "suspended"); // stable resumable state
        suspended = true;
        break;
      }
    }
    if (pages >= MAX_PAGES) truncated = true;
  } catch (err) {
    if (signal.aborted) { finalizeAborted(); return; }
    registry.setJobStatus(job.id, "failed", (err as Error).message);
    failed = true;
  }

  if (failed) return;
  if (suspended) return;            // cookie persisted; a resume continues
  if (signal.aborted) { finalizeAborted(); return; }

  // Source exhausted (or capped) → analyze the staged events into the report.
  try {
    const events = readStaging(stagePath);
    const analyzed = applyTreeFilter(events, treeName);
    const report = analyzeJourneyHistory(analyzed);
    if (truncated) report.truncated = true;
    const topEventNames = [...eventNameCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));
    const full = {
      ...report,
      window: { from, to },
      env: job.env,
      source: "live" as const,
      pagesFetched: pages,
      eventsFetched: analyzed.length,
      rawFetched,
      topEventNames,
    };
    fs.mkdirSync(path.dirname(repPath), { recursive: true });
    fs.writeFileSync(repPath, JSON.stringify(full));
    registry.markReportReady(job.id);
    registry.setJobStatus(job.id, "completed");
    try { fs.unlinkSync(stagePath); } catch { /* best-effort cleanup */ }
  } catch (err) {
    registry.setJobStatus(job.id, "failed", `Analysis failed: ${(err as Error).message}`);
  }
}
