import fs from "node:fs";
import { manifestPath } from "./log-archive-paths";
import type { LogArchiveManifest, SourceManifest, TimeRange } from "./log-types";

/** Merge overlapping/adjacent ISO ranges into a sorted, minimal set. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a.from.localeCompare(b.from));
    const out: TimeRange[] = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1];
        const cur = sorted[i];
        // Overlap or touch: next starts at or before the current end.
        if (cur.from <= last.to) {
            if (cur.to > last.to) last.to = cur.to;
        } else {
            out.push({ ...cur });
        }
    }
    return out;
}

/** Return a new manifest with `range` folded into `source`'s coverage. */
export function addCoveredRange(
    manifest: LogArchiveManifest,
    source: string,
    range: TimeRange,
): LogArchiveManifest {
    const prev: SourceManifest = manifest.sources[source] ?? { coveredRanges: [] };
    const coveredRanges = mergeRanges([...prev.coveredRanges, range]);
    const lastPulledTo = !prev.lastPulledTo || range.to > prev.lastPulledTo
        ? range.to
        : prev.lastPulledTo;
    return {
        ...manifest,
        sources: {
            ...manifest.sources,
            [source]: { ...prev, coveredRanges, lastPulledTo },
        },
    };
}

export function readManifest(archiveRoot: string): LogArchiveManifest {
    const p = manifestPath(archiveRoot);
    if (!fs.existsSync(p)) return { sources: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as LogArchiveManifest;
        return parsed && typeof parsed === "object" && parsed.sources ? parsed : { sources: {} };
    } catch {
        return { sources: {} };
    }
}

export function writeManifest(archiveRoot: string, manifest: LogArchiveManifest): void {
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(manifestPath(archiveRoot), JSON.stringify(manifest, null, 2));
}
