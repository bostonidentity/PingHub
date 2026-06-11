import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { fetchLogPage, paceDelayMs, isVolumeQuota429, VOLUME_QUOTA_MESSAGE } from "@/lib/logs/log-fetch";
import { ThrottleGovernor } from "./journey-throttle-governor";
import { analyzeJourneyHistory, emptyRollup, mergeRollup, type RawAuthEvent } from "./journey-history";
import { buildJourneyQueryFilter, filterEventsByJourneys, MAX_SERVER_FILTER_JOURNEYS } from "./journey-filter";
import { stagingPath as stagingPathFor, reportPath as reportPathFor, rawDir, rawWindowPath } from "./journey-report-paths";
import { pruneRawRetention } from "./journey-raw";
import { AUTO_RECOVERY_MAX_EPISODES, type JourneyReportJob, type JourneyReportPartial } from "./journey-report-types";
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

// Minimum delay between page requests within a window (proactively avoids 429s).
const DEFAULT_REQUEST_DELAY_MS = 5_000;
const MAX_REQUEST_DELAY_MS = 60_000;

// Floor on each 429 retry backoff. AIC's Retry-After can under-report (e.g. 3s),
// so start no lower than this and grow past it under sustained throttling.
const RETRY_BACKOFF_FLOOR_MS = 5_000;

// How many of the most-recent matched events to surface live (for the UI feed).
const RECENT_EVENTS_KEPT = 15;

// A throughput 429 that survives fetchLogPage's retries triggers an automatic
// cooldown-and-retry (resuming from the persisted cursor) rather than pausing.
// After AUTO_RECOVERY_MAX_EPISODES failed episodes it gives up and pauses (resumable).
// Cooldown before the k-th (1-based) auto-recovery retry: 30s, 60s, 120s … capped.
const AUTO_RECOVERY_BASE_MS = 30_000;
const AUTO_RECOVERY_CAP_MS = 300_000;
const recoveryCooldownMs = (attempt: number) =>
  Math.min(AUTO_RECOVERY_CAP_MS, AUTO_RECOVERY_BASE_MS * 2 ** Math.max(0, attempt - 1));

// Only reached once auto-recovery is exhausted — the run pauses (resumable);
// completed windows/pages are preserved.
const RATE_LIMITED_NOTE =
  `Rate limited by AIC (HTTP 429) — auto-retried ${AUTO_RECOVERY_MAX_EPISODES}× without ` +
  'clearing, so the run is paused. Resume to keep trying, or lower "Parallel windows".';

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

  const { from, to, treeNames = [], maxEvents, summaryOnly, windowHours, windowConcurrency, retainRaw } = job.params;

  // Opt-in: keep each window's matched-event NDJSON for offline inspection (re-analyze
  // without re-pulling). Move a finished window's staging file into the raw store
  // rather than deleting it; a successful run records `rawJobId` and prunes old runs.
  const retainWindow = (srcFile: string, window: number) => {
    if (!retainRaw) { try { fs.unlinkSync(srcFile); } catch { /* best-effort */ } return; }
    try {
      const dst = rawWindowPath(reportRoot, job.id, window);
      fs.mkdirSync(rawDir(reportRoot, job.id), { recursive: true });
      fs.renameSync(srcFile, dst);
    } catch { try { fs.unlinkSync(srcFile); } catch { /* best-effort */ } }
  };
  const rawMeta = retainRaw ? { rawJobId: job.id } : {};
  // Floor on inter-page delay (default 5s); header pacing + adaptive 429 bump stack on top.
  const baseDelayMs = Math.min(MAX_REQUEST_DELAY_MS, Math.max(0, job.params.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS));
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

  // Self-tuning response to throughput 429s: the governor owns the adaptive pacing
  // floor, the parallel-window concurrency (auto-lowers under pressure, recovers when
  // clean), the per-page retry budget, and the "currently throttling" flag that drives
  // the live banner. Concurrency recovers toward the user's setting, never above it.
  const baseConcurrency = Math.min(Math.max(1, windowConcurrency || DEFAULT_WINDOW_CONCURRENCY), MAX_WINDOW_CONCURRENCY);
  const governor = new ThrottleGovernor({ baseConcurrency, seedThrottles: p.throttles ?? 0 });
  // Surface every 429 live (count + last wait/attempt + active flag) so the UI shows
  // each reject, not just the final outcome — same idea as the Logs tab's per-429 message.
  const onThrottle = (waitMs: number, attempt: number) => {
    governor.onThrottle(waitMs, attempt);
    registry.updateProgress(job.id, {
      throttles: governor.throttles, lastThrottleWaitMs: waitMs, lastThrottleAttempt: attempt, throttling: true,
    });
  };

  // A throughput 429 outlived the per-page retries. Instead of pausing for a manual
  // resume, cool down (concurrency slammed to 1, paced maximally) and retry from the
  // persisted cursor — up to AUTO_RECOVERY_MAX_EPISODES times. The job stays "running"
  // so the UI shows live auto-retry progress, not a stuck pause.
  let recoveryEpisodes = 0;
  const coolDownAndRetry = async (): Promise<"retry" | "exhausted" | "aborted"> => {
    recoveryEpisodes++;
    if (recoveryEpisodes > AUTO_RECOVERY_MAX_EPISODES) {
      registry.updateProgress(job.id, { recovering: false, recoveryAttempt: AUTO_RECOVERY_MAX_EPISODES });
      return "exhausted";
    }
    governor.onRateLimitEpisode();
    const waitMs = recoveryCooldownMs(recoveryEpisodes);
    registry.updateProgress(job.id, {
      throttling: true, recovering: true, recoveryAttempt: recoveryEpisodes, recoveryWaitMs: waitMs,
    });
    await sleepFn(waitMs, signal);
    if (signal.aborted) return "aborted";
    registry.updateProgress(job.id, { recovering: false });
    return "retry";
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

      const throttlesBefore = governor.throttles;
      const res = await fetchLogPage(url, headers, {
        fetchFn, signal, sleepFn, onThrottle, maxRetries: governor.maxRetries(), minBackoffMs: RETRY_BACKOFF_FLOOR_MS,
      });
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

      // Feed the page outcome back to the governor (adjusts concurrency/retry/pacing)
      // and surface whether the run is still actively throttling.
      governor.onPage(governor.throttles > throttlesBefore);
      registry.updateProgress(job.id, { throttling: governor.isThrottling() });

      cookie = truncated ? undefined : (data.pagedResultsCookie ?? undefined);
      onProgress(snapshot(), lastTs, recent.slice());

      if (truncated || !cookie) break;

      // Pace under the rate limit: base floor, header-based pacing, and adaptive 429 bump.
      const wait = Math.max(paceDelayMs(res, nowMs()), baseDelayMs, governor.floorMs());
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
      // Page the window, auto-recovering through cooldowns on rate-limited outcomes.
      let start = prepareCursor(wantsResume);
      let cursor: WindowCursor;
      for (;;) {
        const r = await pageWindow({ win: windows[0], winStage: stagePath, start, suspendOnHeap: true, onProgress });
        cursor = r.cursor;
        if (r.outcome === "failed") { registry.setJobStatus(job.id, "failed", r.error); return; }
        if (r.outcome === "suspended") { registry.setJobStatus(job.id, "suspended"); return; }
        if (r.outcome === "aborted") { finalizeAborted(); return; }
        if (r.outcome === "rateLimited") {
          const decision = await coolDownAndRetry();
          if (decision === "aborted") { finalizeAborted(); return; }
          if (decision === "exhausted") { registry.setJobStatus(job.id, "suspended", RATE_LIMITED_NOTE); return; }
          start = r.cursor; // resume from the last good page
          continue;
        }
        break; // done
      }

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
          generatedAt: new Date().toISOString(),
          ...(treeNames.length ? { selectedJourneys: treeNames } : {}),
          ...rawMeta,
        });
        registry.markReportReady(job.id);
        registry.setJobStatus(job.id, "completed");
        retainWindow(stagePath, 0); // delete, or keep the raw for offline inspection
        if (retainRaw) pruneRawRetention(reportRoot);
      } catch (err) {
        registry.setJobStatus(job.id, "failed", `Analysis failed: ${(err as Error).message}`);
      }
      return;
    }

    // ---- Chunked: page windows in an adaptive-concurrency pool, merge rollups. ----
    // Resume is window-level: completed windows' rollups are folded into `partial`
    // and skipped; any window that didn't finish is re-run from its first page.
    // In-flight windows track the governor's target, which auto-lowers under 429
    // pressure and recovers toward `baseConcurrency` as pages come through clean.
    const completed = new Set<number>(p.completedWindows ?? []);
    let partial: JourneyReportPartial = p.partial ?? {
      rollup: emptyRollup(), eventNameCounts: {}, rawTotal: 0, matchedTotal: 0, pagesTotal: 0, anyTruncated: false,
    };
    let pending = windows.map((w, i) => ({ w, i })).filter(({ i }) => !completed.has(i));

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
        rollup: mergeRollup(partial.rollup, { summary: winReport.summary, perJourney: winReport.perJourney, nodeStructure: winReport.nodeStructure }),
        eventNameCounts,
        rawTotal: partial.rawTotal + cursor.rawFetched,
        matchedTotal: partial.matchedTotal + cursor.matched,
        pagesTotal: partial.pagesTotal + cursor.pages,
        anyTruncated: partial.anyTruncated || cursor.truncated,
      };
      completed.add(i);
      retainWindow(winStagePath(i), i); // delete, or move into the raw store when retaining
      registry.updateProgress(job.id, {
        windowsTotal: windows.length, windowsDone: completed.size, completedWindows: [...completed], partial,
        page: partial.pagesTotal, rawFetched: partial.rawTotal, matched: partial.matchedTotal,
      });
    };

    let nextIdx = 0;
    let active = 0;
    let livePages = 0;
    let failed = false, aborted = false, rateLimited = false, failError: string | undefined;
    const terminal = () => failed || aborted || rateLimited || signal.aborted;
    // Per page across all in-flight windows: surface the latest matched events and a
    // live "still working" signal (page tick + how many windows are paging right now)
    // so the status line keeps moving between window completions and reflects the
    // governor's auto-tuned concurrency. Workers clobber recentEvents — fine for a feed.
    const onProgress = (_c: WindowCursor, _lastTs: string | undefined, recent: RecentEvent[]) =>
      registry.updateProgress(job.id, { recentEvents: recent, livePages: ++livePages, windowsInFlight: active });

    // Page a single window to completion, folding its rollup or latching a terminal flag.
    const runWindow = async (slot: number): Promise<void> => {
      const { w, i } = pending[slot];
      fs.writeFileSync(winStagePath(i), ""); // fresh start (drop any prior partial window file)
      const { outcome, cursor, error } = await pageWindow({
        win: w, winStage: winStagePath(i), start: freshCursor(), suspendOnHeap: false, onProgress,
      });
      if (outcome === "aborted") { aborted = true; return; }
      if (outcome === "rateLimited") { rateLimited = true; return; }
      if (outcome === "failed") { failed = true; failError = error; return; }
      foldWindow(i, cursor); // outcome === "done"
    };

    // Run the pool, auto-recovering through cooldowns on rate-limited outcomes. Each
    // attempt re-pages only the still-incomplete windows (completed ones are already
    // folded into `partial`); a rate-limited window simply stays pending and re-runs.
    for (;;) {
      pending = windows.map((w, i) => ({ w, i })).filter(({ i }) => !completed.has(i));
      if (pending.length === 0) break;
      nextIdx = 0; active = 0; rateLimited = false;

      // Adaptive pool: top the in-flight window count up to the governor's *current*
      // target whenever a window finishes. A lowered target shrinks the pool (finished
      // windows aren't replaced); a recovered target grows it back — both at one-window
      // granularity. Each window is launched at most once (nextIdx only advances).
      await new Promise<void>((resolve) => {
        const supervise = () => {
          while (!terminal() && active < governor.targetConcurrency() && nextIdx < pending.length) {
            const slot = nextIdx++;
            active++;
            runWindow(slot).finally(() => { active--; supervise(); });
          }
          if (active === 0) resolve();
        };
        supervise();
      });

      if (failed) { registry.setJobStatus(job.id, "failed", failError); return; }
      if (aborted || signal.aborted) { finalizeAborted(); return; }
      if (rateLimited) {
        const decision = await coolDownAndRetry();
        if (decision === "aborted") { finalizeAborted(); return; }
        if (decision === "exhausted") { registry.setJobStatus(job.id, "suspended", RATE_LIMITED_NOTE); return; }
        continue;
      }
      break; // all windows done
    }

    try {
      const topEventNames = Object.entries(partial.eventNameCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }));
      writeReport(repPath, {
        summary: partial.rollup.summary,
        attempts: [],
        perJourney: partial.rollup.perJourney,
        nodeStructure: partial.rollup.nodeStructure,
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
        generatedAt: new Date().toISOString(),
        ...(treeNames.length ? { selectedJourneys: treeNames } : {}),
        ...(partial.anyTruncated ? { truncated: true } : {}),
        ...rawMeta,
      });
      registry.markReportReady(job.id);
      registry.setJobStatus(job.id, "completed");
      // Folded windows were already moved into the raw store (or deleted); drop any stragglers.
      for (let i = 0; i < windows.length; i++) { try { fs.unlinkSync(winStagePath(i)); } catch { /* best-effort */ } }
      try { fs.unlinkSync(stagePath); } catch { /* best-effort cleanup */ }
      if (retainRaw) pruneRawRetention(reportRoot);
    } catch (err) {
      registry.setJobStatus(job.id, "failed", `Analysis failed: ${(err as Error).message}`);
    }
  } catch (err) {
    if (signal.aborted) { finalizeAborted(); return; }
    registry.setJobStatus(job.id, "failed", (err as Error).message);
  }
}
