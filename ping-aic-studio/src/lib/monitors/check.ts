import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import type { MonitorCheckResult, MonitorStatus, MonitorTarget } from "./types";

const DEFAULT_TIMEOUT_MS = 5000;
const BODY_SNIPPET_MAX = 512;
const BODY_READ_MAX = 64 * 1024; // 64 KiB cap on read body
const HEALTHY_REGEX_DEFAULT = /^(UP|OK|HEALTHY|READY|ALIVE|PASS|PASSING|TRUE|RUNNING|GREEN|ACTIVE)$/i;
const DEGRADED_REGEX = /^(WARN|WARNING|DEGRADED|YELLOW|STARTING|SLOW|UNKNOWN)$/i;

/**
 * Run a single monitor health check.
 *
 * The check is purely informational — `ok` / `degraded` / `down` is derived
 * from HTTP status and a best-effort scan of the response body. Network or
 * TLS errors map to `down`. A non-2xx response also maps to `down` unless
 * the body suggests `degraded`.
 */
export async function runMonitorCheck(target: MonitorTarget): Promise<MonitorCheckResult> {
    const start = Date.now();
    const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let parsed: URL;
    try {
        parsed = new URL(target.url);
    } catch {
        return {
            id: target.id,
            status: "down",
            latencyMs: 0,
            message: "Invalid URL",
            error: `Could not parse URL: ${target.url}`,
            checkedAt: new Date().toISOString(),
        };
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const headers: Record<string, string> = {
        "User-Agent": "PingHub-Monitor/1.0",
        Accept: "application/json, text/plain, */*",
        ...(target.headers ?? {}),
    };
    if (target.auth) {
        if (target.auth.kind === "basic" && target.auth.username) {
            const creds = `${target.auth.username}:${target.auth.password ?? ""}`;
            headers.Authorization = `Basic ${Buffer.from(creds).toString("base64")}`;
        } else if (target.auth.kind === "bearer" && target.auth.token) {
            headers.Authorization = `Bearer ${target.auth.token}`;
        }
    }

    return new Promise<MonitorCheckResult>((resolve) => {
        const req = lib.request(
            {
                method: target.method ?? "GET",
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers,
                timeout: timeoutMs,
                // Allow self-signed / invalid certs when explicitly opted in.
                rejectUnauthorized: isHttps ? !(target.insecureTls ?? false) : undefined,
            },
            (res) => {
                let bytes = 0;
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes <= BODY_READ_MAX) chunks.push(chunk);
                });
                res.on("end", () => {
                    const latencyMs = Date.now() - start;
                    const body = Buffer.concat(chunks).toString("utf8");
                    const httpStatus = res.statusCode ?? 0;
                    const evaluated = evaluate(httpStatus, body, target);
                    resolve({
                        id: target.id,
                        status: evaluated.status,
                        httpStatus,
                        latencyMs,
                        message: evaluated.message,
                        bodySnippet: snippet(body),
                        checkedAt: new Date().toISOString(),
                    });
                });
                res.on("error", (err) => {
                    resolve(errorResult(target.id, start, err));
                });
            },
        );

        req.on("timeout", () => {
            req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
        });
        req.on("error", (err) => {
            resolve(errorResult(target.id, start, err));
        });
        req.end();
    });
}

function snippet(body: string): string | undefined {
    if (!body) return undefined;
    return body.length > BODY_SNIPPET_MAX ? body.slice(0, BODY_SNIPPET_MAX) + "…" : body;
}

function errorResult(id: string, start: number, err: Error): MonitorCheckResult {
    const msg = err.message || String(err);
    return {
        id,
        status: "down",
        latencyMs: Date.now() - start,
        message: classifyError(msg),
        error: msg,
        checkedAt: new Date().toISOString(),
    };
}

function classifyError(msg: string): string {
    if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return "DNS lookup failed";
    if (/ECONNREFUSED/.test(msg)) return "Connection refused";
    if (/ECONNRESET/.test(msg)) return "Connection reset";
    if (/ETIMEDOUT|Timeout/i.test(msg)) return "Request timed out";
    if (/CERT|TLS|SSL|self.signed/i.test(msg)) return "TLS/certificate error";
    return "Request failed";
}

function evaluate(
    httpStatus: number,
    body: string,
    target: MonitorTarget,
): { status: MonitorStatus; message: string } {
    const ok2xx = httpStatus >= 200 && httpStatus < 300;

    // Body-substring checks apply regardless of JSON/HTML/text content.
    // If any required substring is missing, demote the result.
    const requiredSubstrings = (target.expect?.bodyContains ?? []).filter((s) => s.length > 0);
    const missingSubstrings = requiredSubstrings.filter((s) => !body.includes(s));

    const base = evaluateCore(httpStatus, body, target, ok2xx);

    if (requiredSubstrings.length > 0) {
        if (missingSubstrings.length === 0) {
            const note = `contains "${requiredSubstrings[0]}"${requiredSubstrings.length > 1 ? ` +${requiredSubstrings.length - 1}` : ""}`;
            return { status: base.status, message: `${base.message} · ${note}` };
        }
        // At least one required substring missing.
        const missingNote = `missing "${missingSubstrings[0]}"${missingSubstrings.length > 1 ? ` +${missingSubstrings.length - 1}` : ""}`;
        if (base.status === "down") {
            return { status: "down", message: `${base.message} · ${missingNote}` };
        }
        return { status: "degraded", message: `${base.message} · ${missingNote}` };
    }

    return base;
}

function evaluateCore(
    httpStatus: number,
    body: string,
    target: MonitorTarget,
    ok2xx: boolean,
): { status: MonitorStatus; message: string } {
    // Try to parse as JSON and extract a status-ish field.
    let json: unknown = undefined;
    if (body.trim().startsWith("{") || body.trim().startsWith("[")) {
        try {
            json = JSON.parse(body);
        } catch {
            json = undefined;
        }
    }

    const healthyRe = target.expect?.valueRegex
        ? safeRegex(target.expect.valueRegex)
        : HEALTHY_REGEX_DEFAULT;

    const explicitPaths = target.expect?.jsonPaths;
    if (json !== undefined) {
        const paths = explicitPaths && explicitPaths.length > 0
            ? explicitPaths
            : ["status", "state", "health", "health.status", "live", "ready", "result"];

        const found: Array<{ path: string; value: unknown }> = [];
        for (const p of paths) {
            const v = getPath(json, p);
            if (v !== undefined) found.push({ path: p, value: v });
        }

        if (found.length > 0) {
            let healthyCount = 0;
            let degradedCount = 0;
            for (const { value } of found) {
                const v = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
                if (healthyRe.test(v)) healthyCount++;
                else if (DEGRADED_REGEX.test(v)) degradedCount++;
            }
            if (!ok2xx) {
                return { status: "down", message: `HTTP ${httpStatus} · ${describeFound(found)}` };
            }
            if (healthyCount === found.length) {
                return { status: "ok", message: `HTTP ${httpStatus} · ${describeFound(found)}` };
            }
            if (healthyCount > 0 || degradedCount > 0) {
                return { status: "degraded", message: `HTTP ${httpStatus} · ${describeFound(found)}` };
            }
            return { status: "down", message: `HTTP ${httpStatus} · ${describeFound(found)}` };
        }
        // JSON parsed but no recognized field — fall through to status-code heuristic.
    }

    // No JSON status field — look at plain text body.
    const trimmed = body.trim();
    if (ok2xx) {
        if (!trimmed) return { status: "ok", message: `HTTP ${httpStatus} · empty body` };
        if (trimmed.length < 64 && healthyRe.test(trimmed)) {
            return { status: "ok", message: `HTTP ${httpStatus} · ${trimmed}` };
        }
        if (trimmed.length < 64 && DEGRADED_REGEX.test(trimmed)) {
            return { status: "degraded", message: `HTTP ${httpStatus} · ${trimmed}` };
        }
        return { status: "ok", message: `HTTP ${httpStatus}` };
    }
    if (httpStatus === 401 || httpStatus === 403) {
        return { status: "down", message: `HTTP ${httpStatus} · authentication required` };
    }
    if (httpStatus >= 500) {
        return { status: "down", message: `HTTP ${httpStatus} · server error` };
    }
    return { status: "down", message: `HTTP ${httpStatus}` };
}

function describeFound(found: Array<{ path: string; value: unknown }>): string {
    return found
        .slice(0, 3)
        .map(({ path, value }) => {
            const v = typeof value === "object" ? JSON.stringify(value) : String(value);
            return `${path}=${v.length > 40 ? v.slice(0, 40) + "…" : v}`;
        })
        .join(", ");
}

function safeRegex(src: string): RegExp {
    try {
        return new RegExp(src, "i");
    } catch {
        return HEALTHY_REGEX_DEFAULT;
    }
}

function getPath(obj: unknown, dotted: string): unknown {
    const parts = dotted.split(".");
    let cur: unknown = obj;
    for (const p of parts) {
        if (cur === null || cur === undefined) return undefined;
        if (typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}
