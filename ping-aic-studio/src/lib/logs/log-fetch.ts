const DEFAULT_MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 30_000;
/** Pace proactively once remaining headroom drops to this many requests. */
const PACE_THRESHOLD = 1;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchLogPageOpts {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    sleepFn?: (ms: number) => Promise<void>;
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
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
        opts.onThrottle?.(waitMs, attempt);
        await sleepFn(waitMs);
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
    const resetSec = Number(resetRaw);
    if (!Number.isFinite(remaining) || !Number.isFinite(resetSec)) return 0;
    if (remaining > PACE_THRESHOLD) return 0;
    return Math.max(0, resetSec * 1000 - nowMs);
}
