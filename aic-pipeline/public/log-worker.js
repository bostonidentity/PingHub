/**
 * Log fetch worker — runs entirely off the main thread.
 *
 * Inbound messages (from component):
 *   { type: "fetch",      env, sources, beginTime, endTime, queryFilter?, levels? }
 *   { type: "fetch-pause" }
 *   { type: "fetch-resume" }
 *   { type: "fetch-stop" }
 *   { type: "tail-start", env, sources, tailSecs, levels? }
 *   { type: "tail-stop" }
 *   { type: "cancel" }
 *
 *   `levels` (when present) is an array of effective level strings
 *   (e.g. ["SEVERE","ERROR","FATAL"]) that the API route translates into a
 *   server-side `_queryFilter` so AIC never ships unwanted entries.
 *
 * Outbound messages (to component):
 *   { type: "entries",  entries: LogEntry[], append: boolean }
 *   { type: "status",   loading: boolean }
 *   { type: "progress", loaded: number, page: number, done: boolean, paused: boolean, source?: string, window?: string }
 *   { type: "error",    message: string }
 */

// Tail state is keyed by source so we can tail multiple sources concurrently
// (e.g. am-everything + idm-everything on the same screen).
//
// `tailTimers`  — pending setTimeout id for each source's NEXT tick. Cleared
//                 on stop. We use setTimeout (not setInterval) so the next
//                 tick is only scheduled AFTER the current drain finishes,
//                 preventing overlap when a backlog takes longer than
//                 `tailSecs` to drain.
// `tailCookies` — last `pagedResultsCookie` per source (for resume across ticks).
// `tailGen`     — monotonic generation per source. Bumped on stop/restart so a
//                 mid-flight drain that wakes up later can detect it's stale
//                 and abort cleanly.
// `tailSleepRejects` — per-source reject fn for the inter-page sleep, so
//                 stopTail() can interrupt a drain immediately instead of
//                 waiting up to RATE_LIMIT_DELAY ms.
let tailTimers = new Map();        // source -> timeoutId
let tailCookies = new Map();       // source -> pagedResultsCookie
let tailGen = new Map();           // source -> generation number
let tailSleepRejects = new Map();  // source -> reject fn for in-flight sleep
let currentFetchId = 0;

// Search pagination state
let searchCookie = null;
let searchParams = null;
let searchPaused = false;
let searchResolveResume = null; // resolve function for pause promise
let sleepReject = null; // reject function to interrupt sleep on stop

const RATE_LIMIT_DELAY = 1100; // 1.1s between pages (60 req/min limit)
const MAX_RETRIES = 5;
const MAX_CHUNK_MS = 23 * 60 * 60 * 1000; // AIC limit: < 1 day per request
// Per tick, drain at most this many pages before yielding to the next scheduled
// tick. With RATE_LIMIT_DELAY = 1100 ms, 25 pages ≈ 27.5 s — enough to absorb
// large bursts but bounded so a single source can't monopolise the rate-limit
// budget when multiple sources are tailed concurrently.
const MAX_TAIL_PAGES_PER_TICK = 25;

/** Split a time range into sub-day chunks if it exceeds 23 hours. */
function splitTimeRange(beginTime, endTime) {
  const start = new Date(beginTime).getTime();
  const end = new Date(endTime).getTime();
  const chunks = [];
  let chunkStart = start;
  while (chunkStart < end) {
    const chunkEnd = Math.min(chunkStart + MAX_CHUNK_MS, end);
    chunks.push({ beginTime: new Date(chunkStart).toISOString(), endTime: new Date(chunkEnd).toISOString() });
    chunkStart = chunkEnd;
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => { sleepReject = null; resolve(); }, ms);
    sleepReject = () => { clearTimeout(id); reject(new Error("cancelled")); sleepReject = null; };
  });
}

async function apiPost(body, retries = MAX_RETRIES, attempt = 0) {
  const res = await fetch("/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && retries > 0) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
    // Exponential backoff: 5s, 10s, 20s, 40s, 80s — respect Retry-After if larger
    const backoff = Math.pow(2, attempt) * 5000;
    const waitMs = Math.max(retryAfter * 1000, backoff);
    self.postMessage({ type: "error", message: `Rate limited — retrying in ${Math.ceil(waitMs / 1000)}s… (attempt ${attempt + 1}/${MAX_RETRIES})`, transient: true });
    await sleep(waitMs);
    return apiPost(body, retries - 1, attempt + 1);
  }
  return res.json();
}

function waitForResume() {
  return new Promise((resolve) => { searchResolveResume = resolve; });
}

async function doFetch(env, sources, beginTime, endTime, queryFilter, levels, fetchId) {
  self.postMessage({ type: "status", loading: true });

  // Split into sub-day chunks when the range exceeds the AIC 1-day limit
  const chunks = (beginTime && endTime) ? splitTimeRange(beginTime, endTime) : [{ beginTime, endTime }];

  let totalLoaded = 0;
  let pageNum = 0;
  let isVeryFirst = true;
  let lastTimestamp = null; // track latest entry timestamp for progress

  if (!sources || sources.length === 0) {
    self.postMessage({ type: "error", message: "No log source selected." });
    self.postMessage({ type: "status", loading: false });
    self.postMessage({ type: "progress", loaded: 0, page: 0, done: true, paused: false });
    return;
  }

  // Filter out any blank entries that could slip through
  const validSources = sources.filter(Boolean);

  try {
    for (let si = 0; si < validSources.length; si++) {
      const source = validSources[si];
      const isLastSource = si === validSources.length - 1;

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        if (fetchId !== currentFetchId) return;

        let cookie = null;

        do {
          if (fetchId !== currentFetchId) return;

          // Check if paused
          if (searchPaused) {
            self.postMessage({ type: "progress", loaded: totalLoaded, page: pageNum, done: false, paused: true, source, sourceIdx: si, sourceCount: validSources.length, lastTimestamp, overallBegin: beginTime, overallEnd: endTime });
            await waitForResume();
            if (fetchId !== currentFetchId) return;
          }

          // Rate limit delay between pages (skip very first request)
          if (!isVeryFirst) await sleep(RATE_LIMIT_DELAY);

          pageNum++;
          const data = await apiPost({
            env, source,
            beginTime: chunk.beginTime,
            endTime: chunk.endTime,
            ...(queryFilter ? { queryFilter } : {}),
            ...(levels && levels.length ? { levels } : {}),
            cookie: cookie ?? undefined,
          });

          if (fetchId !== currentFetchId) return;

          if (data.error) {
            self.postMessage({ type: "error", message: data.error });
            self.postMessage({ type: "status", loading: false });
            self.postMessage({ type: "progress", loaded: totalLoaded, page: pageNum, done: true, paused: false });
            return;
          }

          const entries = Array.isArray(data.result) ? data.result : [];
          cookie = data.pagedResultsCookie ?? null;
          totalLoaded += entries.length;

          // Track latest timestamp for progress reporting
          if (entries.length > 0) {
            const last = entries[entries.length - 1];
            if (last && last.timestamp) lastTimestamp = last.timestamp;
          }

          // Store for resume
          searchCookie = cookie;
          searchParams = { env, sources, beginTime: chunk.beginTime, endTime: chunk.endTime, queryFilter };

          const isLastChunk = ci === chunks.length - 1;
          // Format begin/end as the user's local YYYY-MM-DD (avoid UTC slice, which can
          // roll the date forward when the local time is late evening).
          const fmtLocalDate = (iso) => {
            const d = new Date(iso);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
          };
          const windowStr = chunk.beginTime
            ? fmtLocalDate(chunk.beginTime) + (chunk.endTime ? ' \u2192 ' + fmtLocalDate(chunk.endTime) : '')
            : '';
          self.postMessage({ type: "entries", entries, append: !isVeryFirst });
          self.postMessage({ type: "progress", loaded: totalLoaded, page: pageNum, done: isLastSource && isLastChunk && !cookie, paused: false, source, window: windowStr, sourceIdx: si, sourceCount: validSources.length, lastTimestamp, overallBegin: beginTime, overallEnd: endTime });

          if (isVeryFirst) {
            self.postMessage({ type: "status", loading: false });
            isVeryFirst = false;
          }
        } while (cookie);
      }
    }

    self.postMessage({ type: "progress", loaded: totalLoaded, page: pageNum, done: true, paused: false });
  } catch (e) {
    if (fetchId !== currentFetchId) return;
    self.postMessage({ type: "error", message: String(e) });
    self.postMessage({ type: "status", loading: false });
    self.postMessage({ type: "progress", loaded: totalLoaded, page: pageNum, done: true, paused: false });
  }
}

/**
 * Per-source tail sleep. Like the global `sleep()` but registers its reject
 * fn in `tailSleepRejects` so `stopTail()` can cancel a drain immediately
 * instead of waiting up to RATE_LIMIT_DELAY ms.
 */
function tailSleep(source, ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => { tailSleepRejects.delete(source); resolve(); }, ms);
    tailSleepRejects.set(source, () => {
      clearTimeout(id);
      tailSleepRejects.delete(source);
      reject(new Error("cancelled"));
    });
  });
}

/**
 * Run one tail tick for a source: drain as many pages as available (up to
 * MAX_TAIL_PAGES_PER_TICK), batching entries into a single postMessage so the
 * UI sees one append per tick rather than one per page. After the drain
 * completes, schedule the next tick `tailSecs * 1000` ms later via setTimeout.
 *
 * Generation guard: each tail-start bumps `tailGen` for the source. If a stale
 * tick wakes up after a stop/restart, it observes the mismatch and returns
 * without firing more requests or scheduling another tick.
 */
async function doTailTick(env, source, levels, tailSecs, gen) {
  if (tailGen.get(source) !== gen) return;
  let pageCount = 0;
  try {
    let cookie = tailCookies.get(source) ?? undefined;
    do {
      if (tailGen.get(source) !== gen) return;
      if (pageCount > 0) {
        // Stay under AIC's 60 req/min cap when draining a backlog.
        try { await tailSleep(source, RATE_LIMIT_DELAY); } catch { return; }
        if (tailGen.get(source) !== gen) return;
      }
      const data = await apiPost(
        { env, source, tail: true, cookie, ...(levels && levels.length ? { levels } : {}) },
        MAX_RETRIES,
      );
      if (tailGen.get(source) !== gen) return;
      console.log("[log-worker] tail page", { source, pageCount: pageCount + 1, entries: Array.isArray(data?.result) ? data.result.length : 0, hasCookie: !!data?.pagedResultsCookie, error: data?.error });
      if (data.error) {
        self.postMessage({ type: "error", message: data.error });
        break;
      }
      const entries = Array.isArray(data.result) ? data.result : [];
      cookie = data.pagedResultsCookie ?? null;
      tailCookies.set(source, cookie);
      pageCount++;
      if (entries.length > 0) {
        // Tag each entry with its source so the UI can distinguish when
        // multiple sources are tailed on the same screen.
        for (const entry of entries) {
          if (entry && typeof entry === "object" && entry.source == null) entry.source = source;
        }
        // Stream each page to the UI immediately so users see progress while
        // a backlog drains, instead of waiting for the whole tick to finish.
        self.postMessage({ type: "entries", entries, append: true });
      }
      if (pageCount >= MAX_TAIL_PAGES_PER_TICK) break;
    } while (cookie);
  } catch (e) {
    if (tailGen.get(source) !== gen) return;
    self.postMessage({ type: "error", message: String(e) });
  }

  if (tailGen.get(source) !== gen) return;
  // Schedule the next tick AFTER drain finishes — guarantees no overlap.
  const id = setTimeout(() => doTailTick(env, source, levels, tailSecs, gen), tailSecs * 1000);
  tailTimers.set(source, id);
}

function stopTail() {
  for (const id of tailTimers.values()) clearTimeout(id);
  tailTimers.clear();
  // Bump generation for every active source so any in-flight drain aborts.
  for (const source of tailGen.keys()) {
    tailGen.set(source, (tailGen.get(source) ?? 0) + 1);
  }
  // Interrupt any pending inter-page sleeps.
  for (const reject of tailSleepRejects.values()) {
    try { reject(); } catch { /* ignore */ }
  }
  tailSleepRejects.clear();
  tailCookies.clear();
}

function stopSearch() {
  searchCookie = null;
  searchParams = null;
  searchPaused = false;
  if (searchResolveResume) { searchResolveResume(); searchResolveResume = null; }
  if (sleepReject) { sleepReject(); sleepReject = null; }
}

self.onmessage = async function (e) {
  const msg = e.data;

  switch (msg.type) {
    case "fetch":
      stopTail();
      stopSearch();
      sleepReject = null; // ensure no stale reject from previous operations
      currentFetchId++;
      // Support both new multi-source (msg.sources) and old single-source (msg.source) formats
      const fetchSources = msg.sources && msg.sources.length > 0 ? msg.sources
        : msg.source ? [msg.source] : [];
      await doFetch(msg.env, fetchSources, msg.beginTime, msg.endTime, msg.queryFilter ?? null, msg.levels ?? null, currentFetchId);
      break;

    case "fetch-pause":
      searchPaused = true;
      break;

    case "fetch-resume":
      searchPaused = false;
      if (searchResolveResume) { searchResolveResume(); searchResolveResume = null; }
      break;

    case "fetch-stop":
      stopSearch();
      currentFetchId++;
      self.postMessage({ type: "status", loading: false });
      self.postMessage({ type: "progress", loaded: 0, page: 0, done: true, paused: false });
      break;

    case "tail-start": {
      stopTail();
      stopSearch();
      currentFetchId++;
      // Accept either new multi-source (msg.sources) or legacy single (msg.source)
      const tailSources = Array.isArray(msg.sources) && msg.sources.length > 0
        ? msg.sources.filter(Boolean)
        : msg.source ? [msg.source] : [];
      if (tailSources.length === 0) {
        self.postMessage({ type: "error", message: "No log source selected for tailing." });
        break;
      }
      const tailLevels = Array.isArray(msg.levels) && msg.levels.length > 0 ? msg.levels : null;
      const tailSecs = Math.max(1, Number(msg.tailSecs) || 5);
      console.log("[log-worker] tail-start", { env: msg.env, sources: tailSources, tailSecs, levels: tailLevels });
      // Kick off the first tick for each source immediately. Each tick
      // self-reschedules via setTimeout when its drain finishes.
      for (const src of tailSources) {
        const gen = (tailGen.get(src) ?? 0) + 1;
        tailGen.set(src, gen);
        // Fire-and-forget; doTailTick handles its own errors and rescheduling.
        doTailTick(msg.env, src, tailLevels, tailSecs, gen);
      }
      break;
    }

    case "tail-stop":
      stopTail();
      break;

    case "cancel":
      stopTail();
      stopSearch();
      currentFetchId++;
      self.postMessage({ type: "status", loading: false });
      self.postMessage({ type: "progress", loaded: 0, page: 0, done: true, paused: false });
      break;
  }
};
