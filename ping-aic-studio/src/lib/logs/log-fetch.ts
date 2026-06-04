const DEFAULT_MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 30_000;

/** Each throughput 429 raises the caller's inter-page pacing floor by this much. */
export const AUTO_BUMP_MS = 150;
/** Ceiling for the adaptive pacing floor (mirrors the Logs tab's 5s cap). */
export const MAX_BUMP_MS = 5_000;

// AIC returns 429 for two unrelated reasons: a per-minute throughput rate-limit
// (retriable) and a per-tenant 24-hour log-volume cap (NOT retriable — only a
// smaller request clears it). Same phrasing the Logs-tab worker keys on.
const VOLUME_QUOTA_RE = /more log data than permitted|log.*quota|exceeded.*log/i;

/** True when a 429 body indicates AIC's per-tenant log-volume cap. Retrying or
 *  slowing down cannot clear it — the only fix is a smaller request. */
export function isVolumeQuota429(bodyText: string): boolean {
    return VOLUME_QUOTA_RE.test(bodyText);
}

/** Actionable error for a volume-quota 429 — surfaced in place of a raw "HTTP 429". */
export const VOLUME_QUOTA_MESSAGE =
    'AIC log-volume quota hit (HTTP 429: "more log data than permitted") — a per-tenant ' +
    "24-hour download cap, not a per-minute rate limit, so retrying or pacing will not help. " +
    "Narrow the request: shorten the time range, deselect some sources, or pull a smaller window.";
/**
 * Pace proactively once remaining headroom drops to this many requests. At 1 we
 * deliberately sacrifice the last slot to absorb clock skew between us and AIC's
 * window reset (so practical throughput is ~limit-1 per window, not the full limit).
 */
const PACE_THRESHOLD = 1;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        const id = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
    });

export interface FetchLogPageOpts {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
    maxRetries?: number;
    /** Called each time a 429 forces a backoff (for progress/telemetry). */
    onThrottle?: (waitMs: number, attempt: number) => void;
}

/**
 * Fetch one page, retrying on HTTP 429. Honors a `Retry-After` header (seconds);
 * otherwise backs off exponentially (1s·2^attempt, capped). After `maxRetries`
 * exhausted retries it returns the last (429) response so the caller can decide.
 *
 * A *volume-quota* 429 (per-tenant 24h cap) is terminal — it short-circuits with
 * no retries, since neither backoff nor pacing can clear it. Only *throughput*
 * 429s are retried (and reported via `onThrottle` so the caller can slow down).
 */
export async function fetchLogPage(
    url: string,
    headers: Record<string, string>,
    opts: FetchLogPageOpts = {},
): Promise<Response> {
    const fetchFn = opts.fetchFn ?? fetch;
    const sleepFn = opts.sleepFn ?? defaultSleep;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

    let attempt = 0;
    for (;;) {
        const res = await fetchFn(url, { headers, signal: opts.signal });
        if (res.status !== 429) return res;
        // Peek a clone so the caller can still read the original body. A
        // volume-quota 429 is terminal — return it immediately, unretried.
        const peek = await res.clone().text().catch(() => "");
        if (isVolumeQuota429(peek)) return res;
        attempt++;
        if (attempt > maxRetries) return res;
        // AIC sends numeric seconds per the timing baseline. An HTTP-date Retry-After
        // would parse to NaN and fall through to exponential backoff — a safe default.
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
        opts.onThrottle?.(waitMs, attempt);
        await sleepFn(waitMs, opts.signal);
    }
}

/**
 * Proactive pacing: given a response's rate-limit headers and the current epoch
 * time in ms, return how long to wait before the next request to avoid tripping
 * the limit. Returns 0 when there's headroom or the headers are absent.
 *
 * Headers: `x-ratelimit-remaining` (requests left), `x-ratelimit-reset` (epoch
 * SECONDS at which the window resets).
 */
export function paceDelayMs(res: Response, nowMs: number): number {
    const remainingRaw = res.headers.get("x-ratelimit-remaining");
    const resetRaw = res.headers.get("x-ratelimit-reset");
    if (remainingRaw === null || resetRaw === null) return 0;
    const remaining = Number(remainingRaw);
    // Assumes x-ratelimit-reset is epoch SECONDS (verified against the tenant in the
    // timing baseline). If a tenant ever returns delta-seconds instead, this subtraction
    // goes negative and clamps to 0 (proactive pacing disabled, reactive 429 path still works).
    const resetSec = Number(resetRaw);
    if (!Number.isFinite(remaining) || !Number.isFinite(resetSec)) return 0;
    if (remaining > PACE_THRESHOLD) return 0;
    return Math.max(0, resetSec * 1000 - nowMs);
}
