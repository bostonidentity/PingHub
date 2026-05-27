"use client";

/**
 * Side-by-side diff viewer for the Browse-tab compare mode.
 *
 * Matches the Compare tab's `SplitDiffView` (Source | Modified columns,
 * red/green row highlighting, right-side minimap) so history-version diffs
 * render the same way as journey/script diffs in the Compare tab. Adds a
 * "changes only" toggle that hides context rows.
 */
import { useMemo, useRef, useState } from "react";
import { clientDiff, formatForDiff, summarizeDiff, toSplitRows } from "@/lib/client-diff";
import { DiffMinimap } from "@/app/compare/DiffMinimap";
import { cn } from "@/lib/utils";

export interface FileDiffViewerProps {
    aContent: string;
    bContent: string;
    aLabel: string;
    bLabel: string;
    fileName: string;
}

export function FileDiffViewer({ aContent, bContent, aLabel, bLabel, fileName }: FileDiffViewerProps) {
    const [changesOnly, setChangesOnly] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { allLines, summary } = useMemo(() => {
        const a = formatForDiff(aContent, fileName);
        const b = formatForDiff(bContent, fileName);
        const lines = clientDiff(a, b);
        return { allLines: lines, summary: summarizeDiff(lines) };
    }, [aContent, bContent, fileName]);

    const visibleLines = useMemo(
        () => (changesOnly ? allLines.filter((l) => l.type !== "context") : allLines),
        [allLines, changesOnly],
    );
    const rows = useMemo(() => toSplitRows(visibleLines), [visibleLines]);

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
                <button
                    type="button"
                    onClick={() => setChangesOnly((v) => !v)}
                    className={cn(
                        "ml-2 px-2 py-0.5 rounded border text-[10px] font-mono transition-colors",
                        changesOnly
                            ? "bg-slate-700 border-slate-500 text-slate-100"
                            : "bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200",
                    )}
                    title="Toggle to hide unchanged lines"
                >
                    {changesOnly ? "Showing changes only" : "Show changes only"}
                </button>
                <span className="ml-auto flex items-center gap-2 font-mono">
                    <span className="text-emerald-400">+{summary.added}</span>
                    <span className="text-rose-400">-{summary.removed}</span>
                    {summary.added === 0 && summary.removed === 0 && (
                        <span className="text-slate-500">(no changes)</span>
                    )}
                </span>
            </div>
            <div className="flex flex-1 min-h-0 bg-slate-950">
                <div ref={scrollRef} className="flex-1 overflow-auto text-[10px] font-mono leading-5">
                    <table className="w-full border-collapse table-fixed">
                        <thead>
                            <tr className="border-b border-slate-700 bg-slate-900 text-[9px] text-slate-500 sticky top-0 z-10">
                                <th className="px-3 py-1 text-left font-normal border-r border-slate-700 w-1/2">Source</th>
                                <th className="px-3 py-1 text-left font-normal w-1/2">Modified</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 ? (
                                <tr>
                                    <td colSpan={2} className="px-3 py-2 text-center text-slate-500">
                                        {changesOnly ? "(no changes)" : ""}
                                    </td>
                                </tr>
                            ) : (
                                rows.map((row, i) => (
                                    <tr key={i}>
                                        <td className={cn(
                                            "px-3 py-0 whitespace-pre-wrap break-all align-top border-r border-slate-800 w-1/2",
                                            row.leftRem ? "bg-red-950 text-red-300" : "text-slate-400",
                                        )}>
                                            {row.left ?? ""}
                                        </td>
                                        <td className={cn(
                                            "px-3 py-0 whitespace-pre-wrap break-all align-top w-1/2",
                                            row.rightAdd ? "bg-emerald-950 text-emerald-300" : "text-slate-400",
                                        )}>
                                            {row.right ?? ""}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
                <DiffMinimap lines={visibleLines} scrollRef={scrollRef} />
            </div>
        </div>
    );
}
