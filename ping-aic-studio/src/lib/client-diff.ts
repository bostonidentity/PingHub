/**
 * Client-side line diff + content formatting. Extracted from
 * `app/compare/DiffReport.tsx` so Browse-tab compare can reuse it without
 * pulling in the promotion-task surface area.
 */
import { js_beautify } from "js-beautify";
import { diffArrays } from "diff";
import type { DiffLine } from "@/lib/diff-types";

/**
 * Pretty-print JSON; beautify JS / Groovy. Anything else is returned as-is.
 * Mirrors `formatContent` in DiffReport so historical-version diffs render
 * the same way the Compare page does.
 */
export function formatForDiff(content: string, fileName: string): string {
    try {
        return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
        /* not JSON */
    }
    if (/\.(js|groovy)$/i.test(fileName)) {
        return js_beautify(content, { indent_size: 2, end_with_newline: true });
    }
    return content;
}

// Hard safety wall — Myers diff is O((m+n)·D) so it handles 10s of thousands
// of lines comfortably, but we still cap to avoid pathological cases where
// almost every line differs (D ≈ m + n).
const MAX_LINES = 50_000;

/**
 * Myers line diff (via `diff` package). Handles large scripts that the old
 * O(m·n) LCS would refuse to touch.
 */
export function clientDiff(aText: string, bText: string): DiffLine[] {
    const a = aText === "" ? [] : aText.split("\n");
    const b = bText === "" ? [] : bText.split("\n");
    if (a.length > MAX_LINES || b.length > MAX_LINES) {
        return [
            {
                type: "context",
                content: `(file too large to diff in browser — ${a.length} vs ${b.length} lines)`,
            },
        ];
    }
    const changes = diffArrays(a, b);
    const lines: DiffLine[] = [];
    for (const change of changes) {
        const type: DiffLine["type"] = change.added
            ? "added"
            : change.removed
                ? "removed"
                : "context";
        for (const value of change.value) {
            lines.push({ type, content: value });
        }
    }
    return lines;
}

/** Summarise a diff into `{added, removed, unchanged}` line counts. */
export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number; context: number } {
    let added = 0;
    let removed = 0;
    let context = 0;
    for (const l of lines) {
        if (l.type === "added") added++;
        else if (l.type === "removed") removed++;
        else context++;
    }
    return { added, removed, context };
}

/**
 * One row of a side-by-side diff. `leftRem` indicates the left cell is a
 * removed line (red); `rightAdd` indicates the right cell is an added line
 * (green). A context row has both flags false and `left === right`.
 */
export type SplitRow = {
    left: string | null;
    leftRem: boolean;
    right: string | null;
    rightAdd: boolean;
};

/**
 * Convert a flat diff line sequence into paired side-by-side rows.
 *
 * Mirrors `SplitDiffView` in `app/compare/JourneyDiffGraph.tsx`: context
 * lines map 1:1 to both columns; consecutive removed/added blocks are
 * paired by index, with the longer side spilling into null cells on the
 * shorter side.
 */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
    const rows: SplitRow[] = [];
    let i = 0;
    while (i < lines.length) {
        if (lines[i].type === "context") {
            rows.push({ left: lines[i].content, leftRem: false, right: lines[i].content, rightAdd: false });
            i++;
            continue;
        }
        const removed: string[] = [];
        const added: string[] = [];
        while (i < lines.length && lines[i].type !== "context") {
            if (lines[i].type === "removed") removed.push(lines[i].content);
            else added.push(lines[i].content);
            i++;
        }
        const len = Math.max(removed.length, added.length);
        for (let j = 0; j < len; j++) {
            rows.push({
                left: removed[j] ?? null,
                leftRem: removed[j] !== undefined,
                right: added[j] ?? null,
                rightAdd: added[j] !== undefined,
            });
        }
    }
    return rows;
}
