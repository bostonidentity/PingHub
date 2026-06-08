import { describe, it, expect, vi } from "vitest";
import { fetchLogPage, paceDelayMs, isVolumeQuota429 } from "./log-fetch";

/** Minimal Response stub with just the surface log-fetch reads. `body` backs
 *  both text() and clone().text() (a constant string is trivially re-readable). */
function res(status: number, headers: Record<string, string> = {}, body = ""): Response {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const r = {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
        text: async () => body,
        clone: () => r,
    };
    return r as unknown as Response;
}

describe("fetchLogPage", () => {
    it("returns immediately on a 200", async () => {
        const fetchFn = vi.fn().mockResolvedValue(res(200));
        const r = await fetchLogPage("http://x", {}, { fetchFn });
        expect(r.status).toBe(200);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("retries on 429 honoring Retry-After, then succeeds", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429, { "retry-after": "3" }))
            .mockResolvedValueOnce(res(200));
        const sleeps: number[] = [];
        const sleepFn = async (ms: number) => { sleeps.push(ms); };
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn });
        expect(r.status).toBe(200);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(sleeps).toEqual([3000]); // Retry-After seconds → ms
    });

    it("falls back to exponential backoff when Retry-After is absent", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429))
            .mockResolvedValueOnce(res(429))
            .mockResolvedValueOnce(res(200));
        const sleeps: number[] = [];
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn: async (ms) => { sleeps.push(ms); } });
        expect(r.status).toBe(200);
        expect(sleeps).toEqual([2000, 4000]); // 1000 * 2^attempt
    });

    it("with minBackoffMs, floors the wait and grows it past a (possibly low) Retry-After", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429, { "retry-after": "3" })) // attempt 1: max(5000, 3000, 2000)
            .mockResolvedValueOnce(res(429, { "retry-after": "3" })) // attempt 2: max(5000, 3000, 4000)
            .mockResolvedValueOnce(res(429))                         // attempt 3: max(5000, 0,    8000)
            .mockResolvedValueOnce(res(200));
        const sleeps: number[] = [];
        const r = await fetchLogPage("http://x", {}, {
            fetchFn, sleepFn: async (ms) => { sleeps.push(ms); }, minBackoffMs: 5000,
        });
        expect(r.status).toBe(200);
        expect(sleeps).toEqual([5000, 5000, 8000]);
    });

    it("with minBackoffMs, still honors a Retry-After larger than the floor/backoff", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429, { "retry-after": "20" }))
            .mockResolvedValueOnce(res(200));
        const sleeps: number[] = [];
        const r = await fetchLogPage("http://x", {}, {
            fetchFn, sleepFn: async (ms) => { sleeps.push(ms); }, minBackoffMs: 5000,
        });
        expect(r.status).toBe(200);
        expect(sleeps).toEqual([20000]); // 20s Retry-After wins over the 5s floor
    });

    it("gives up after maxRetries and returns the last 429", async () => {
        const fetchFn = vi.fn().mockResolvedValue(res(429, { "retry-after": "1" }));
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn: async () => {}, maxRetries: 2 });
        expect(r.status).toBe(429);
        expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("invokes onThrottle with the wait and attempt number on each 429", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429, { "retry-after": "3" }))
            .mockResolvedValueOnce(res(200));
        const throttles: Array<[number, number]> = [];
        await fetchLogPage("http://x", {}, {
            fetchFn,
            sleepFn: async () => {},
            onThrottle: (waitMs, attempt) => throttles.push([waitMs, attempt]),
        });
        expect(throttles).toEqual([[3000, 1]]);
    });

    it("does NOT retry a volume-quota 429 — it is terminal", async () => {
        const fetchFn = vi.fn().mockResolvedValue(
            res(429, {}, JSON.stringify({ message: "Request would return more log data than permitted" })),
        );
        const sleeps: number[] = [];
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn: async (ms) => { sleeps.push(ms); } });
        expect(r.status).toBe(429);
        expect(fetchFn).toHaveBeenCalledTimes(1); // short-circuited, no retries
        expect(sleeps).toEqual([]);               // never backed off
    });

    it("still retries a throughput 429 whose body is not a quota error", async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(res(429, {}, "too many requests"))
            .mockResolvedValueOnce(res(200));
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn: async () => {} });
        expect(r.status).toBe(200);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("resolves the backoff sleep early when the signal aborts (default sleep)", async () => {
        const ac = new AbortController();
        const fetchFn = vi.fn().mockResolvedValue(res(429, { "retry-after": "300" }));
        // Abort almost immediately; the real default sleep must resolve instead of waiting 300s.
        setTimeout(() => ac.abort(), 5);
        const r = await fetchLogPage("http://x", {}, { fetchFn, signal: ac.signal, maxRetries: 1 });
        expect(r.status).toBe(429); // gave up after maxRetries, but did NOT hang for 300s
    });
});

describe("isVolumeQuota429", () => {
    it("matches the AIC log-volume cap phrasings", () => {
        expect(isVolumeQuota429("Request would return more log data than permitted")).toBe(true);
        expect(isVolumeQuota429("log quota exceeded for this window")).toBe(true);
        expect(isVolumeQuota429("you have exceeded the log download limit")).toBe(true);
    });
    it("does not match a plain throughput rate-limit body", () => {
        expect(isVolumeQuota429("Too Many Requests")).toBe(false);
        expect(isVolumeQuota429("")).toBe(false);
    });
});

describe("paceDelayMs", () => {
    it("returns 0 when remaining is healthy", () => {
        expect(paceDelayMs(res(200, { "x-ratelimit-remaining": "30", "x-ratelimit-reset": "1000" }), 0)).toBe(0);
    });

    it("waits until reset when remaining is exhausted", () => {
        // reset = 1000s epoch → 1_000_000 ms; now = 400_000 ms → wait 600_000 ms.
        expect(paceDelayMs(res(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }), 400_000)).toBe(600_000);
    });

    it("never returns a negative wait", () => {
        expect(paceDelayMs(res(200, { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1000" }), 2_000_000)).toBe(0);
    });

    it("returns 0 when headers are missing", () => {
        expect(paceDelayMs(res(200), 0)).toBe(0);
    });
});
