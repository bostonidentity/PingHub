import path from "node:path";
import { ENVIRONMENTS_DIR } from "@/lib/paths";

/** UTC `YYYY-MM-DD` for an ISO timestamp (handles nanosecond precision). */
export function dayKey(isoTimestamp: string): string {
    const d = new Date(isoTimestamp);
    if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${isoTimestamp}`);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** A single, safe path segment: no separators, no traversal. */
function safeSeg(value: string, label: string): string {
    if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
        throw new Error(`invalid ${label}: ${value}`);
    }
    return value;
}

/** Archive root for an environment: `ENVIRONMENTS_DIR/{env}/log-data`. */
export function logDataDir(env: string): string {
    return path.join(ENVIRONMENTS_DIR, safeSeg(env, "env"), "log-data");
}

export function sourceDir(archiveRoot: string, source: string): string {
    return path.join(archiveRoot, safeSeg(source, "source"));
}

export function dayNdjsonPath(archiveRoot: string, source: string, day: string): string {
    return path.join(sourceDir(archiveRoot, source), `${safeSeg(day, "day")}.ndjson`);
}

export function dayDbPath(archiveRoot: string, source: string, day: string): string {
    return path.join(sourceDir(archiveRoot, source), `${safeSeg(day, "day")}.sqlite`);
}

export function manifestPath(archiveRoot: string): string {
    return path.join(archiveRoot, "manifest.json");
}
