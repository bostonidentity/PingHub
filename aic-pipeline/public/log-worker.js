/**
 * Log fetch worker — runs entirely off the main thread.
 *
 * Inbound messages (from component):
 *   { type: "fetch",      env, sources, beginTime, endTime, queryFilter? }
 *   { type: "fetch-pause" }
 *   { type: "fetch-resume" }
 *   { type: "fetch-stop" }
 *   { type: "tail-start", env, source, tailSecs }
 *   { type: "tail-stop" }
 *   { type: "cancel" }
 *
 * Outbound messages (to component):
 *   { type: "entries",  entries: LogEntry[], append: boolean }
 *   { type: "status",   loading: boolean }
 *   { type: "progress", loaded: number, page: number, done: boolean, paused: boolean, source?: string, window?: string }
 *   { type: "error",    message: string }
 */

// Tail state is keyed by source so we can tail multiple sources concurrently
// (e.g. am-everything + idm-everything on the same screen).
let tailIntervals = new Map(); // source -> intervalId
let tailCookies = new Map();   // source -> pagedResultsCookie
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

async function doFetch(env, sources, beginTime, endTime, queryFilter, fetchId) {
  self.postMessage({ type: "status", loading: true });

  // Split into sub-day chunks when the range exceeds the AIC 1-day limit
  const chunks = (beginTime && endTime) ? splitTimeRange(beginTime, endTime) : [{ beginTime, endTime }];

  let totalLoaded = 0;
  let pageNum = 0;
  let isVeryFirst = true;

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
            self.postMessage({ type: "progress", loaded: totalLoaded, page: pageNum, done: false, paused: true });
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

          // Store for resume
          searchCookie = cookie;
          searchParams = { env, sources, beginTime: chunk.beginTime, endTime: chunk.endTime, queryFilter };

          const isLastChunk = ci === chunks.length - 1;
          const windowStr = chunk.beginTime
            ? chunk.beginTime.slice(0, 10) + (chunk.endTime ? ' → ' + chunk.endTime.slice(0, 10) : '')
            : '';
          self.postMessage({ type: "entries", entries, append: !isVeryFirst });
          self.postMessage({ type: "progress", loaded: totalLoaded, page: pageNum, done: isLastSource && isLastChunk && !cookie, paused: false, source, window: windowStr });

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

async function doTailPoll(env, source) {
  try {
    const cookie = tailCookies.get(source) ?? undefined;
    const data = await apiPost({ env, source, tail: true, cookie }, MAX_RETRIES);

    if (data.error) {
      self.postMessage({ type: "error", message: data.error });
      return;
    }

    const entries = Array.isArray(data.result) ? data.result : [];
    tailCookies.set(source, data.pagedResultsCookie ?? null);

    if (entries.length > 0) {
      // Tag each entry with its source so the UI can distinguish when
      // multiple sources are tailed on the same screen.
      for (const entry of entries) {
        if (entry && typeof entry === "object" && entry.source == null) entry.source = source;
      }
      self.postMessage({ type: "entries", entries, append: true });
    }
  } catch (e) {
    self.postMessage({ type: "error", message: String(e) });
  }
}

function stopTail() {
  for (const id of tailIntervals.values()) clearInterval(id);
  tailIntervals.clear();
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
      await doFetch(msg.env, fetchSources, msg.beginTime, msg.endTime, msg.queryFilter ?? null, currentFetchId);
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
      // Kick off an initial poll for each source in parallel, then schedule intervals.
      await Promise.all(tailSources.map((src) => doTailPoll(msg.env, src)));
      for (const src of tailSources) {
        const id = setInterval(() => doTailPoll(msg.env, src), msg.tailSecs * 1000);
        tailIntervals.set(src, id);
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
