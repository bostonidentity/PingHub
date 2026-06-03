import { describe, it, expect, vi } from "vitest";
import { fetchLogPage, paceDelayMs } from "./log-fetch";

/** Minimal Response stub with just the surface log-fetch reads. */
function res(status: number, headers: Record<string, string> = {}): Response {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
        text: async () => "",
    } as unknown as Response;
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

    it("gives up after maxRetries and returns the last 429", async () => {
        const fetchFn = vi.fn().mockResolvedValue(res(429, { "retry-after": "1" }));
        const r = await fetchLogPage("http://x", {}, { fetchFn, sleepFn: async () => {}, maxRetries: 2 });
        expect(r.status).toBe(429);
        expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
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
