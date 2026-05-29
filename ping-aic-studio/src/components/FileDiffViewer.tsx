"use client";

/**
 * Unified diff viewer for the Browse-tab compare mode.
 *
 * Mirrors the Compare tab's per-file `DiffViewer` (unified +/- columns with
 * left/right line numbers, collapsed unchanged hunks that expand on click,
 * syntax highlighting, right-side minimap) so history-version diffs render
 * the same way as the main Compare report.
 */
import { useMemo, useRef, useState } from "react";
import { clientDiff, formatForDiff, summarizeDiff } from "@/lib/client-diff";
import type { DiffLine } from "@/lib/diff-types";
import { DiffMinimap } from "@/app/compare/DiffMinimap";
import { cn } from "@/lib/utils";

export interface FileDiffViewerProps {
    aContent: string;
    bContent: string;
    aLabel: string;
    bLabel: string;
    fileName: string;
}

// ── Syntax highlight (mirrors highlightLine in app/compare/DiffReport.tsx) ───

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightLine(raw: string): string {
    return escapeHtml(raw).replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
            let color = "#60a5fa";
            if (/^"/.test(match)) color = /:$/.test(match) ? "#94a3b8" : "#86efac";
            else if (/true|false/.test(match)) color = "#fbbf24";
            else if (/null/.test(match)) color = "#f87171";
            return `<span style="color:${color}">${match}</span>`;
        },
    );
}

// ── Context collapsing (mirrors buildHunks in app/compare/DiffReport.tsx) ────

const CONTEXT_LINES = 3;

type HunkItem = DiffLine | { type: "ellipsis"; count: number; startIdx: number };

function buildHunks(lines: DiffLine[]): HunkItem[] {
    const changed = new Set<number>();
    lines.forEach((l, i) => { if (l.type !== "context") changed.add(i); });

    const visible = new Set<number>();
    for (const idx of changed) {
        for (let j = Math.max(0, idx - CONTEXT_LINES); j <= Math.min(lines.length - 1, idx + CONTEXT_LINES); j++) {
            visible.add(j);
        }
    }

    const result: HunkItem[] = [];
    let i = 0;
    while (i < lines.length) {
        if (visible.has(i)) {
            result.push(lines[i]);
            i++;
        } else {
            const start = i;
            while (i < lines.length && !visible.has(i)) i++;
            result.push({ type: "ellipsis", count: i - start, startIdx: start });
        }
    }
    return result;
}

export function FileDiffViewer({ aContent, bContent, aLabel, bLabel, fileName }: FileDiffViewerProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());

    const { allLines, summary } = useMemo(() => {
        const a = formatForDiff(aContent, fileName);
        const b = formatForDiff(bContent, fileName);
        const lines = clientDiff(a, b);
        return { allLines: lines, summary: summarizeDiff(lines) };
    }, [aContent, bContent, fileName]);

    const hunks = useMemo(() => buildHunks(allLines), [allLines]);

    const lineNums = useMemo<Array<{ left: number | null; right: number | null }>>(() => {
        let leftNo = 0, rightNo = 0;
        return allLines.map((l) => {
            if (l.type === "removed") { leftNo++; return { left: leftNo, right: null }; }
            if (l.type === "added") { rightNo++; return { left: null, right: rightNo }; }
            leftNo++; rightNo++;
            return { left: leftNo, right: rightNo };
        });
    }, [allLines]);

    let lineIdx = 0;

    return (
        <div className="h-full flex flex-col">
            <div className="px-3 py-1.5 border-b border-slate-700 bg-slate-900 flex items-center gap-3 text-[11px] text-slate-300 shrink-0">
                <span className="flex items-center gap-1">
                    <span className="px-1.5 py-0.5 rounded bg-rose-900/50 text-rose-200 font-mono">A</span>
                    <span className="truncate max-w-[14rem]" title={aLabel}>{aLabel}</span>
                </span>
                <span className="text-slate-500">vs</span>
                <span className="flex items-center gap-1">
                    <span className="px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-200 font-mono">B</span>
                    <span className="truncate max-w-[14rem]" title={bLabel}>{bLabel}</span>
                </span>
                <span className="ml-auto flex items-center gap-2 font-mono">
                    <span className="text-emerald-400">+{summary.added}</span>
                    <span className="text-rose-400">-{summary.removed}</span>
                    {summary.added === 0 && summary.removed === 0 && (
                        <span className="text-slate-500">(no changes)</span>
                    )}
                </span>
            </div>
            <div className="flex flex-1 min-h-0 bg-slate-950 overflow-hidden">
                <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-auto text-[11px] font-mono leading-5">
                    <table className="min-w-full border-collapse">
                        <tbody>
                            {hunks.map((item, hi) => {
                                if (item.type === "ellipsis") {
                                    const si = item.startIdx;
                                    lineIdx += item.count;
                                    const isOpen = expanded.has(si);
                                    return (
                                        <tr key={`e-${hi}`} className="bg-slate-900">
                                            <td colSpan={4} className="py-0.5 px-3 text-center">
                                                <button
                                                    type="button"
                                                    onClick={() => setExpanded((prev) => {
                                                        const s = new Set(prev);
                                                        if (s.has(si)) s.delete(si); else s.add(si);
                                                        return s;
                                                    })}
                                                    className="text-sky-500 hover:text-sky-300 text-[10px]"
                                                >
                                                    {isOpen
                                                        ? "▲ collapse"
                                                        : `▼ ${item.count} unchanged line${item.count !== 1 ? "s" : ""}`}
                                                </button>
                                                {isOpen && allLines.slice(si, si + item.count).map((l, j) => {
                                                    const { left, right } = lineNums[si + j];
                                                    return (
                                                        <div key={j} className="text-left flex">
                                                            <span className="select-none text-slate-600 text-right w-10 border-r border-slate-800 px-2">{left}</span>
                                                            <span className="select-none text-slate-600 text-right w-10 border-r border-slate-800 px-2">{right}</span>
                                                            <span className="select-none w-4 px-1 text-slate-600"> </span>
                                                            <span
                                                                className="px-2 text-slate-500 whitespace-pre"
                                                                dangerouslySetInnerHTML={{ __html: highlightLine(l.content) }}
                                                            />
                                                        </div>
                                                    );
                                                })}
                                            </td>
                                        </tr>
                                    );
                                }

                                const l = item as DiffLine;
                                const { left, right } = lineNums[lineIdx++];
                                const bg = l.type === "added" ? "bg-emerald-950" : l.type === "removed" ? "bg-red-950" : "";
                                const pfxColor = l.type === "added" ? "text-emerald-400" : l.type === "removed" ? "text-red-400" : "text-slate-600";
                                const textColor = l.type === "added" ? "text-emerald-300" : l.type === "removed" ? "text-red-300" : "text-slate-400";
                                const prefix = l.type === "added" ? "+" : l.type === "removed" ? "-" : " ";

                                return (
                                    <tr key={`l-${hi}`} className={bg}>
                                        <td className="select-none text-slate-600 text-right px-2 py-0 w-10 border-r border-slate-800">{left ?? ""}</td>
                                        <td className="select-none text-slate-600 text-right px-2 py-0 w-10 border-r border-slate-800">{right ?? ""}</td>
                                        <td className={cn("px-1 py-0 select-none w-4", pfxColor)}>{prefix}</td>
                                        <td
                                            className={cn("px-2 py-0 whitespace-pre", textColor)}
                                            dangerouslySetInnerHTML={{ __html: highlightLine(l.content) }}
                                        />
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <DiffMinimap lines={allLines} scrollRef={scrollRef} />
            </div>
        </div>
    );
}
