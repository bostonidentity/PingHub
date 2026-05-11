/**
 * Client-side LCS line diff + content formatting. Extracted from
 * `app/compare/DiffReport.tsx` so Browse-tab compare can reuse it without
 * pulling in the promotion-task surface area.
 */
import { js_beautify } from "js-beautify";
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

/**
 * LCS-based line diff. Bails on very large files to keep the browser
 * responsive — same threshold (2000 lines) as the Compare page.
 */
export function clientDiff(aText: string, bText: string): DiffLine[] {
    const a = aText === "" ? [] : aText.split("\n");
    const b = bText === "" ? [] : bText.split("\n");
    const m = a.length;
    const n = b.length;
    if (m > 2000 || n > 2000) {
        return [{ type: "context", content: "(file too large to diff in browser)" }];
    }
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const lines: DiffLine[] = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            lines.unshift({ type: "context", content: a[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            lines.unshift({ type: "added", content: b[j - 1] });
            j--;
        } else {
            lines.unshift({ type: "removed", content: a[i - 1] });
            i--;
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
