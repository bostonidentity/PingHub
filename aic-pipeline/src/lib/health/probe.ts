import type { HealthCacheEntry } from "./types";

const PROBE_PATH = "/monitoring/health";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface ProbeOpts {
    timeoutMs?: number;
    /** Override fetch (for tests). */
    fetcher?: typeof fetch;
}

/**
 * Probes the tenant's `/monitoring/health` endpoint. The endpoint requires no
 * authentication on AIC and returns `200 {"status":"OK"}` when healthy.
 *
 * Returns a HealthCacheEntry — never throws. Network or HTTP errors are
 * recorded in the `error` field with status `"unhealthy"`.
 */
export async function probeHealth(tenantUrl: string, opts: ProbeOpts = {}): Promise<HealthCacheEntry> {
    const checkedAt = new Date().toISOString();
    const fetcher = opts.fetcher ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!tenantUrl) {
        return { checkedAt, status: "unhealthy", error: "TENANT_BASE_URL missing" };
    }
    const url = `${tenantUrl.replace(/\/+$/, "")}${PROBE_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
        const res = await fetcher(url, { method: "GET", signal: controller.signal, cache: "no-store" });
        const latencyMs = Date.now() - start;
        if (!res.ok) {
            return { checkedAt, status: "unhealthy", httpStatus: res.status, latencyMs, error: `HTTP ${res.status}` };
        }
        // Body is tiny ({"status":"OK"}); read it but don't fail the probe if it's
        // an unexpected shape — a 200 from /monitoring/health already means the
        // tenant front door is up.
        let bodyOk = true;
        try {
            const text = await res.text();
            const trimmed = text.trim();
            if (trimmed.length > 0) {
                try {
                    const parsed = JSON.parse(trimmed) as { status?: string };
                    if (parsed && typeof parsed.status === "string" && parsed.status.toUpperCase() !== "OK") {
                        bodyOk = false;
                    }
                } catch {
                    // Non-JSON 200: still consider healthy.
                }
            }
        } catch {
            // Body read failed; the status was 200 — still healthy.
        }
        return {
            checkedAt,
            status: bodyOk ? "healthy" : "unhealthy",
            httpStatus: res.status,
            latencyMs,
            error: bodyOk ? undefined : "unexpected body",
        };
    } catch (err) {
        const latencyMs = Date.now() - start;
        const aborted = (err as { name?: string })?.name === "AbortError";
        return {
            checkedAt,
            status: "unhealthy",
            latencyMs,
            error: aborted ? `timeout after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        };
    } finally {
        clearTimeout(timer);
    }
}
