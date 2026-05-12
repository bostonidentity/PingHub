/**
 * Server health monitor data model.
 *
 * Persisted to `<environments-dir>/monitors.json` (a single shared file
 * across all environments). The file is intentionally human-editable.
 */

export type MonitorAuthKind = "none" | "basic" | "bearer";

export type MonitorStatus = "ok" | "degraded" | "down" | "unknown";

export interface MonitorAuth {
    kind: MonitorAuthKind;
    /** For "basic": "user:pass" (stored as-is, no encryption — file lives in repo). */
    username?: string;
    password?: string;
    /** For "bearer": static token value. */
    token?: string;
}

export interface MonitorGroup {
    id: string;
    name: string;
    order: number;
}

export interface MonitorTarget {
    id: string;
    groupId: string;
    label: string;
    url: string;
    method?: "GET" | "HEAD";
    /** Per-target request timeout in ms; defaults to 5000. */
    timeoutMs?: number;
    /** Extra request headers (e.g. `Accept: application/json`). */
    headers?: Record<string, string>;
    /** Allow self-signed / invalid TLS certs. */
    insecureTls?: boolean;
    /** Authentication for the request. */
    auth?: MonitorAuth;
    /**
     * Optional override: if any of these JSON paths exist in the response
     * body, their values are matched (case-insensitive) against this regex
     * to determine `ok`. If omitted, the default heuristic is used.
     */
    expect?: {
        /** JSON paths like "status", "state", "health.status". */
        jsonPaths?: string[];
        /** Regex matched against the extracted value(s); default `^(UP|OK|HEALTHY|READY|ALIVE|PASS|TRUE)$/i`. */
        valueRegex?: string;
        /**
         * Substring(s) that must appear in the response body for the check
         * to be considered healthy. Useful for HTML landing pages where the
         * status comes from page content rather than a JSON field. If any
         * required substring is missing on a 2xx response, the status is
         * downgraded to `degraded`.
         */
        bodyContains?: string[];
    };
    enabled?: boolean;
}

export interface MonitorsFile {
    groups: MonitorGroup[];
    monitors: MonitorTarget[];
}

/** Result of running a single check. */
export interface MonitorCheckResult {
    id: string;
    status: MonitorStatus;
    httpStatus?: number;
    latencyMs: number;
    /** Short human-readable reason / explanation. */
    message: string;
    /** First ~512 chars of the response body (truncated, for the drawer). */
    bodySnippet?: string;
    /** Network or TLS error details, when applicable. */
    error?: string;
    checkedAt: string;
}
