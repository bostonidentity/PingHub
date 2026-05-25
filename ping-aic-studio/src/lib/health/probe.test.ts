import { describe, it, expect, vi } from "vitest";
import { probeHealth } from "@/lib/health/probe";
import { isStale, clampInterval } from "@/lib/health/auto-refresh";

function mkResponse(status: number, body: string): Response {
    return new Response(body, { status });
}

describe("probeHealth", () => {
    it("returns healthy on 200 + status:OK body", async () => {
        const fetcher = vi.fn().mockResolvedValue(mkResponse(200, '{"status":"OK"}'));
        const r = await probeHealth("https://tenant.example.com", { fetcher: fetcher as unknown as typeof fetch });
        expect(r.status).toBe("healthy");
        expect(r.httpStatus).toBe(200);
        expect(typeof r.latencyMs).toBe("number");
        expect(fetcher).toHaveBeenCalledWith(
            "https://tenant.example.com/monitoring/health",
            expect.objectContaining({ method: "GET" }),
        );
    });

    it("treats non-OK body as unhealthy", async () => {
        const fetcher = vi.fn().mockResolvedValue(mkResponse(200, '{"status":"DOWN"}'));
        const r = await probeHealth("https://tenant.example.com", { fetcher: fetcher as unknown as typeof fetch });
        expect(r.status).toBe("unhealthy");
        expect(r.error).toBe("unexpected body");
    });

    it("considers HTTP 503 unhealthy", async () => {
        const fetcher = vi.fn().mockResolvedValue(mkResponse(503, ""));
        const r = await probeHealth("https://tenant.example.com", { fetcher: fetcher as unknown as typeof fetch });
        expect(r.status).toBe("unhealthy");
        expect(r.httpStatus).toBe(503);
    });

    it("returns unhealthy when TENANT_BASE_URL missing", async () => {
        const r = await probeHealth("");
        expect(r.status).toBe("unhealthy");
        expect(r.error).toBe("TENANT_BASE_URL missing");
    });

    it("captures network errors", async () => {
        const fetcher = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
        const r = await probeHealth("https://tenant.example.com", { fetcher: fetcher as unknown as typeof fetch });
        expect(r.status).toBe("unhealthy");
        expect(r.error).toBe("ENOTFOUND");
    });

    it("strips trailing slashes from tenantUrl", async () => {
        const fetcher = vi.fn().mockResolvedValue(mkResponse(200, '{"status":"OK"}'));
        await probeHealth("https://tenant.example.com//", { fetcher: fetcher as unknown as typeof fetch });
        expect(fetcher.mock.calls[0][0]).toBe("https://tenant.example.com/monitoring/health");
    });
});

describe("isStale + clampInterval", () => {
    it("clamps interval into [1, 1440] and defaults to 15", () => {
        expect(clampInterval(undefined)).toBe(15);
        expect(clampInterval(0)).toBe(1);
        expect(clampInterval(99999)).toBe(1440);
        expect(clampInterval(60)).toBe(60);
    });

    it("treats missing/invalid checkedAt as stale", () => {
        expect(isStale(undefined, 15)).toBe(true);
        expect(isStale("not-a-date", 15)).toBe(true);
    });

    it("returns true when older than interval", () => {
        const now = new Date("2026-05-14T12:00:00Z");
        const old = new Date("2026-05-14T11:30:00Z").toISOString();
        expect(isStale(old, 15, now)).toBe(true);
        expect(isStale(old, 60, now)).toBe(false);
    });
});
