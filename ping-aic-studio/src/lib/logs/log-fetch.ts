const DEFAULT_MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 30_000;
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
