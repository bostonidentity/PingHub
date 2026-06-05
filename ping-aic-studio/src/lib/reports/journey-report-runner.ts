import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { fetchLogPage, paceDelayMs, isVolumeQuota429, VOLUME_QUOTA_MESSAGE, AUTO_BUMP_MS, MAX_BUMP_MS } from "@/lib/logs/log-fetch";
import { analyzeJourneyHistory, emptyRollup, mergeRollup, type RawAuthEvent } from "./journey-history";
import { buildJourneyQueryFilter, filterEventsByJourneys, MAX_SERVER_FILTER_JOURNEYS } from "./journey-filter";
import { stagingPath as stagingPathFor, reportPath as reportPathFor } from "./journey-report-paths";
import type { JourneyReportJob, JourneyReportPartial } from "./journey-report-types";
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

// Summary mode: journey success/fail rates only. Drops AM-NODE-LOGIN-COMPLETED
// (the per-node bulk) server-side, so AIC returns ~10x fewer events per page.
const SUMMARY_FILTER = '(/payload/eventName co "AM-TREE-LOGIN-")';
const SUMMARY_EVENT_NAMES = new Set([
  "AM-TREE-LOGIN-INITIATED",
  "AM-TREE-LOGIN-COMPLETED",
]);

const MS_PER_HOUR = 3_600_000;
// AIC rejects any /monitoring/logs query spanning more than a day.
const MAX_WINDOW_HOURS = 24;

// Chunked runs page windows concurrently. The uat tenant served 6 concurrent
// /monitoring/logs queries cleanly but started returning 429s at 8 — so default
// to 4 (comfortably under the burst ceiling) and cap at 6. fetchLogPage still
// retries any stray 429 with backoff, so the cap is a throughput choice, not a
// correctness one.
const DEFAULT_WINDOW_CONCURRENCY = 4;
const MAX_WINDOW_CONCURRENCY = 6;

// How many of the most-recent matched events to surface live (for the UI feed).
const RECENT_EVENTS_KEPT = 15;

// A throughput 429 that survived all fetchLogPage retries pauses the job
// (resumable) instead of failing — completed windows/pages are preserved.
const RATE_LIMITED_NOTE =
  'Rate limited by AIC (HTTP 429) — paused. Resume to continue; lower "Parallel windows" if it recurs.';

/** Journey/tree name for a payload, for the live event feed. */
function recentTreeName(payload: Record<string, unknown>): string | undefined {
  const entries = payload.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    const info = (entries[0] as Record<string, unknown>)?.info;
    if (info && typeof info === "object") {
      const t = (info as Record<string, unknown>).treeName;
      if (typeof t === "string") return t;
    }
  }
  return typeof payload.treeName === "string" ? payload.treeName : undefined;
}

function heapUnderPressure(fraction: number): boolean {
  const { heap_size_limit, used_heap_size } = v8.getHeapStatistics();
  if (!heap_size_limit) return false;
  return used_heap_size / heap_size_limit >= fraction;
}

/**
 * Split [from, to] into `windowHours`-sized windows (clamped to AIC's 24h max).
 * 0/undefined, an unparseable range, or a span that fits one window → a single
 * [from, to] window (so the single-window path keeps its exact behavior).
 */
function splitWindows(fromIso: string, toIso: string, windowHours?: number): { from: string; to: string }[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!windowHours || windowHours <= 0 || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return [{ from: fromIso, to: toIso }];
  }
  const stepMs = Math.floor(Math.min(windowHours, MAX_WINDOW_HOURS) * MS_PER_HOUR);
  const out: { from: string; to: string }[] = [];
  for (let start = from; start < to; start += stepMs) {
    const end = Math.min(start + stepMs, to);
    out.push({ from: new Date(start).toISOString(), to: new Date(end).toISOString() });
  }
  return out.length ? out : [{ from: fromIso, to: toIso }];
}

/** Abort-aware sleep: resolves immediately if the signal is/becomes aborted. */
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
  });

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

function writeReport(repPath: string, report: unknown): void {
  fs.mkdirSync(path.dirname(repPath), { recursive: true });
  fs.writeFileSync(repPath, JSON.stringify(report));
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

/** Per-window paging cursor — also the resume state persisted in progress. */
interface WindowCursor {
  cookie?: string;
  rawFetched: number;
  matched: number;
  pages: number;
  truncated: boolean;
  byteLength: number;
  eventNameCounts: Map<string, number>;
}

type WindowOutcome = "done" | "suspended" | "rateLimited" | "failed" | "aborted";

/** A recently-seen matched event, surfaced live to the UI. */
type RecentEvent = { ts: string; eventName: string; tree?: string };

/**
 * Page `am-authentication` from AIC into a per-job staging file, then analyze it
 * into a report. Mirrors the log pull: 429 retry/backoff (via fetchLogPage),
 * cookie + byteLength persisted per page for resume, adaptive pacing, heap-
 * pressure auto-suspend, and a failure that still reaches a terminal state
 * instead of hanging "running".
 *
 * With `windowHours` set and a range spanning more than one window, the run is
 * chunked: each window is paged and analyzed in turn and the per-journey rollups
 * are merged, so a long range stays under the page/event caps and only one
 * window sits in memory. Multi-window runs emit a rollup-only report (success/
 * fail rates, no per-attempt rows).
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

  const { from, to, treeNames = [], maxEvents, summaryOnly, windowHours, windowConcurrency } = job.params;
  const baseFilter = summaryOnly ? SUMMARY_FILTER : BROAD_FILTER;
  // Live: server-side filter when the selection is small; otherwise (and for
  // every window) filter at analysis time via postFilter.
  const serverFiltered = treeNames.length > 0 && treeNames.length <= MAX_SERVER_FILTER_JOURNEYS;
  const queryFilter = buildJourneyQueryFilter(baseFilter, serverFiltered ? treeNames : []);
  const postFilter = (events: RawAuthEvent[]) =>
    treeNames.length > 0 && !serverFiltered ? filterEventsByJourneys(events, treeNames) : events;
  const wantedEventNames = summaryOnly ? SUMMARY_EVENT_NAMES : WANTED_EVENT_NAMES;
  const windows = splitWindows(from, to, windowHours);
  const chunked = windows.length > 1;
  const p = job.progress;

  // Per-window staging file (parallel windows can't share one). Single-window
  // runs keep using the base path so their page-level resume is unchanged.
  const winStagePath = (i: number) => stagePath.replace(/\.ndjson$/i, `.w${i}.ndjson`);
  const freshCursor = (): WindowCursor => ({ cookie: undefined, rawFetched: 0, matched: 0, pages: 0, truncated: false, byteLength: 0, eventNameCounts: new Map() });

  // Adaptive inter-page pacing floor: each throughput 429 raises it (mirrors log pull).
  // Surface every 429 live (count + last wait/attempt) so the UI shows each reject,
  // not just the final outcome — same idea as the Logs tab's per-429 message.
  const pacing = { floor: 0 };
  let throttles = p.throttles ?? 0;
  const onThrottle = (waitMs: number, attempt: number) => {
    throttles++;
    pacing.floor = Math.min(MAX_BUMP_MS, pacing.floor + AUTO_BUMP_MS);
    registry.updateProgress(job.id, { throttles, lastThrottleWaitMs: waitMs, lastThrottleAttempt: attempt });
  };

  // Page one window from `start` into its own staging file, calling `onProgress`
  // after each page. Returns a terminal outcome WITHOUT setting job status — the
  // caller maps it (single-window persists a resume cursor + auto-suspends on
  // heap; parallel windows run to completion and re-run on resume).
  async function pageWindow(args: {
    win: { from: string; to: string };
    winStage: string;
    start: WindowCursor;
    suspendOnHeap: boolean;
    onProgress: (cursor: WindowCursor, lastTs: string | undefined, recent: RecentEvent[]) => void;
  }): Promise<{ outcome: WindowOutcome; cursor: WindowCursor; error?: string }> {
    const { win, winStage, start, suspendOnHeap, onProgress } = args;
    let { cookie, rawFetched, matched, pages, truncated, byteLength } = start;
    const eventNameCounts = start.eventNameCounts;
    const recent: RecentEvent[] = []; // rolling window of the latest matched events (display only)
    const snapshot = (): WindowCursor => ({ cookie, rawFetched, matched, pages, truncated, byteLength, eventNameCounts });

    while (pages < MAX_PAGES && matched < maxEvents && !truncated) {
      if (signal.aborted) return { outcome: "aborted", cursor: snapshot() };
      pages++;

      const params = new URLSearchParams({
        source: JOURNEY_SOURCE,
        beginTime: win.from,
        endTime: win.to,
        _queryFilter: queryFilter,
        ...(cookie ? { _pagedResultsCookie: cookie } : {}),
      });
      const url = `${base}/monitoring/logs?${params}`;

      const res = await fetchLogPage(url, headers, { fetchFn, signal, sleepFn, onThrottle });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // A throughput 429 that outlived fetchLogPage's retries → pause (resumable),
        // don't fail. Volume-quota 429s and all other errors are terminal.
        if (res.status === 429 && !isVolumeQuota429(body)) {
          return { outcome: "rateLimited", cursor: snapshot() };
        }
        const error = res.status === 429 && isVolumeQuota429(body)
          ? VOLUME_QUOTA_MESSAGE
          : `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
        return { outcome: "failed", cursor: snapshot(), error };
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
        if (typeof evName !== "string" || !wantedEventNames.has(evName)) continue;
        lines += JSON.stringify({ timestamp: r.timestamp, payload }) + "\n";
        matched++;
        lastTs = r.timestamp;
        recent.push({ ts: r.timestamp, eventName: evName, tree: recentTreeName(payload as Record<string, unknown>) });
        if (recent.length > RECENT_EVENTS_KEPT) recent.shift();
      }
      if (lines) {
        fs.appendFileSync(winStage, lines);
        byteLength += Buffer.byteLength(lines);
      }

      cookie = truncated ? undefined : (data.pagedResultsCookie ?? undefined);
      onProgress(snapshot(), lastTs, recent.slice());

      if (truncated || !cookie) break;

      // Pace under the rate limit (header-based + adaptive floor), then check heap.
      const wait = Math.max(paceDelayMs(res, nowMs()), pacing.floor);
      if (wait > 0) await sleepFn(wait, signal);
      if (suspendOnHeap && heapPressureFn()) {
        return { outcome: "suspended", cursor: snapshot() };
      }
    }
    if (pages >= MAX_PAGES) truncated = true;
    return { outcome: "done", cursor: snapshot() };
  }

  // Prepare the staging file + cursor for a window: resume from the persisted
  // cursor (truncating the half-written tail) or start fresh.
  function prepareCursor(resume: boolean): WindowCursor {
    if (resume) {
      fs.truncateSync(stagePath, p.byteLength!);
      return {
        cookie: p.cookie ?? undefined,
        rawFetched: p.rawFetched,
        matched: p.matched,
        pages: p.page,
        truncated: p.truncated ?? false,
        byteLength: p.byteLength!,
        eventNameCounts: new Map(Object.entries(p.eventNameCounts ?? {})),
      };
    }
    fs.writeFileSync(stagePath, "");
    return { cookie: undefined, rawFetched: 0, matched: 0, pages: 0, truncated: false, byteLength: 0, eventNameCounts: new Map() };
  }

  try {
    if (!chunked) {
      // ---- Single window: full per-attempt report (unchanged behavior). ----
      const wantsResume = typeof p.byteLength === "number" && p.byteLength > 0 && fs.existsSync(stagePath);
      const onProgress = (c: WindowCursor, lastTs: string | undefined, recent: RecentEvent[]) => registry.updateProgress(job.id, {
        page: c.pages, rawFetched: c.rawFetched, matched: c.matched, cookie: c.cookie ?? null,
        byteLength: c.byteLength, lastTimestamp: lastTs, truncated: c.truncated,
        eventNameCounts: Object.fromEntries(c.eventNameCounts), recentEvents: recent,
      });
      const { outcome, cursor, error } = await pageWindow({
        win: windows[0], winStage: stagePath, start: prepareCursor(wantsResume), suspendOnHeap: true, onProgress,
      });
      if (outcome === "failed") { registry.setJobStatus(job.id, "failed", error); return; }
      if (outcome === "rateLimited") { registry.setJobStatus(job.id, "suspended", RATE_LIMITED_NOTE); return; }
      if (outcome === "suspended") { registry.setJobStatus(job.id, "suspended"); return; }
      if (outcome === "aborted") { finalizeAborted(); return; }

      try {
        const events = readStaging(stagePath);
        const analyzed = postFilter(events);
        const report = analyzeJourneyHistory(analyzed);
        if (cursor.truncated) report.truncated = true;
        const topEventNames = [...cursor.eventNameCounts.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }));
        writeReport(repPath, {
          ...report,
          window: { from, to },
          env: job.env,
          source: "live" as const,
          pagesFetched: cursor.pages,
          eventsFetched: analyzed.length,
          rawFetched: cursor.rawFetched,
          topEventNames,
          durationMs: Math.max(0, Date.now() - job.startedAt),
          ...(treeNames.length ? { selectedJourneys: treeNames } : {}),
        });
        registry.markReportReady(job.id);
        registry.setJobStatus(job.id, "completed");
        try { fs.unlinkSync(stagePath); } catch { /* best-effort cleanup */ }
      } catch (err) {
        registry.setJobStatus(job.id, "failed", `Analysis failed: ${(err as Error).message}`);
      }
      return;
    }

    // ---- Chunked: page windows in a bounded-concurrency pool, merge rollups. ----
    // Resume is window-level: completed windows' rollups are folded into `partial`
    // and skipped; any window that didn't finish is re-run from its first page.
    const concurrency = Math.min(Math.max(1, windowConcurrency || DEFAULT_WINDOW_CONCURRENCY), MAX_WINDOW_CONCURRENCY);
    const completed = new Set<number>(p.completedWindows ?? []);
    let partial: JourneyReportPartial = p.partial ?? {
      rollup: emptyRollup(), eventNameCounts: {}, rawTotal: 0, matchedTotal: 0, pagesTotal: 0, anyTruncated: false,
    };
    const pending = windows.map((w, i) => ({ w, i })).filter(({ i }) => !completed.has(i));

    registry.updateProgress(job.id, {
      windowsTotal: windows.length, windowsDone: completed.size, completedWindows: [...completed], partial,
    });

    // Fold a finished window into the rollup + persist. Runs synchronously (no
    // await), so concurrent workers never interleave a read-modify-write of `partial`.
    const foldWindow = (i: number, cursor: WindowCursor) => {
      const winReport = analyzeJourneyHistory(postFilter(readStaging(winStagePath(i))));
      const eventNameCounts = { ...partial.eventNameCounts };
      for (const [k, v] of cursor.eventNameCounts) eventNameCounts[k] = (eventNameCounts[k] ?? 0) + v;
      partial = {
        rollup: mergeRollup(partial.rollup, { summary: winReport.summary, perJourney: winReport.perJourney }),
        eventNameCounts,
        rawTotal: partial.rawTotal + cursor.rawFetched,
        matchedTotal: partial.matchedTotal + cursor.matched,
        pagesTotal: partial.pagesTotal + cursor.pages,
        anyTruncated: partial.anyTruncated || cursor.truncated,
      };
      completed.add(i);
      try { fs.unlinkSync(winStagePath(i)); } catch { /* best-effort */ }
      registry.updateProgress(job.id, {
        windowsTotal: windows.length, windowsDone: completed.size, completedWindows: [...completed], partial,
        page: partial.pagesTotal, rawFetched: partial.rawTotal, matched: partial.matchedTotal,
      });
    };

    let nextIdx = 0;
    let failed = false, aborted = false, rateLimited = false, failError: string | undefined;
    // Surface the latest matched events live (workers clobber, last write wins — fine for a feed).
    const onProgress = (_c: WindowCursor, _lastTs: string | undefined, recent: RecentEvent[]) =>
      registry.updateProgress(job.id, { recentEvents: recent });
    const worker = async (): Promise<void> => {
      while (!failed && !aborted && !rateLimited) {
        if (signal.aborted) { aborted = true; return; }
        const slot = nextIdx++;
        if (slot >= pending.length) return;
        const { w, i } = pending[slot];
        fs.writeFileSync(winStagePath(i), ""); // fresh start (drop any prior partial window file)
        const { outcome, cursor, error } = await pageWindow({
          win: w, winStage: winStagePath(i), start: freshCursor(), suspendOnHeap: false, onProgress,
        });
        if (outcome === "aborted") { aborted = true; return; }
        if (outcome === "rateLimited") { rateLimited = true; return; }
        if (outcome === "failed") { failed = true; failError = error; return; }
        foldWindow(i, cursor); // outcome === "done"
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, () => worker()));

    if (failed) { registry.setJobStatus(job.id, "failed", failError); return; }
    if (rateLimited) { registry.setJobStatus(job.id, "suspended", RATE_LIMITED_NOTE); return; }
    if (aborted || signal.aborted) { finalizeAborted(); return; }

    try {
      const topEventNames = Object.entries(partial.eventNameCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }));
      writeReport(repPath, {
        summary: partial.rollup.summary,
        attempts: [],
        perJourney: partial.rollup.perJourney,
        rollupOnly: true,
        windows: windows.length,
        windowHours,
        window: { from, to },
        env: job.env,
        source: "live" as const,
        pagesFetched: partial.pagesTotal,
        eventsFetched: partial.matchedTotal,
        rawFetched: partial.rawTotal,
        topEventNames,
        durationMs: Math.max(0, Date.now() - job.startedAt),
        ...(treeNames.length ? { selectedJourneys: treeNames } : {}),
        ...(partial.anyTruncated ? { truncated: true } : {}),
      });
      registry.markReportReady(job.id);
      registry.setJobStatus(job.id, "completed");
      for (let i = 0; i < windows.length; i++) { try { fs.unlinkSync(winStagePath(i)); } catch { /* best-effort */ } }
      try { fs.unlinkSync(stagePath); } catch { /* best-effort cleanup */ }
    } catch (err) {
      registry.setJobStatus(job.id, "failed", `Analysis failed: ${(err as Error).message}`);
    }
  } catch (err) {
    if (signal.aborted) { finalizeAborted(); return; }
    registry.setJobStatus(job.id, "failed", (err as Error).message);
  }
}
