"use client";

/**
 * Compact unified-diff viewer for the Browse-tab compare mode.
 *
 * Renders a single-pane line diff (left gutter = - sign for removed, + for
 * added) with line numbers per side. Designed to drop into the dark-themed
 * file viewer; for the heavyweight side-by-side, scoped-by-promotion-task
 * viewer see `app/compare/DiffReport.tsx`.
 */
import { useMemo } from "react";
import { clientDiff, formatForDiff, summarizeDiff } from "@/lib/client-diff";
import { cn } from "@/lib/utils";

export interface FileDiffViewerProps {
    aContent: string;
    bContent: string;
    aLabel: string;
    bLabel: string;
    fileName: string;
}

export function FileDiffViewer({ aContent, bContent, aLabel, bLabel, fileName }: FileDiffViewerProps) {
    const { diffLines, summary } = useMemo(() => {
        const a = formatForDiff(aContent, fileName);
        const b = formatForDiff(bContent, fileName);
        const lines = clientDiff(a, b);
        return { diffLines: lines, summary: summarizeDiff(lines) };
    }, [aContent, bContent, fileName]);

    // Track per-side line numbers as we iterate so each row shows a/b columns
    // aligned with the surviving file. Removed lines bump only A; added bump
    // only B; context rows bump both. Matches the conventions of `git diff`.
    let aNum = 0;
    let bNum = 0;

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
            <div className="flex-1 overflow-auto bg-slate-900">
                <pre className="text-[11px] font-mono leading-5">
                    {diffLines.map((line, idx) => {
                        const isAdded = line.type === "added";
                        const isRemoved = line.type === "removed";
                        if (line.type === "context") {
                            aNum++;
                            bNum++;
                        } else if (isAdded) {
                            bNum++;
                        } else if (isRemoved) {
                            aNum++;
                        }
                        return (
                            <div
                                key={idx}
                                className={cn(
                                    "flex",
                                    isAdded && "bg-emerald-950/40",
                                    isRemoved && "bg-rose-950/40",
                                )}
                            >
                                <span className="select-none shrink-0 w-10 text-right pr-2 text-slate-600 tabular-nums">
                                    {isAdded ? "" : aNum}
                                </span>
                                <span className="select-none shrink-0 w-10 text-right pr-2 text-slate-600 tabular-nums">
                                    {isRemoved ? "" : bNum}
                                </span>
                                <span
                                    className={cn(
                                        "select-none shrink-0 w-4 text-center",
                                        isAdded && "text-emerald-400",
                                        isRemoved && "text-rose-400",
                                        line.type === "context" && "text-slate-600",
                                    )}
                                >
                                    {isAdded ? "+" : isRemoved ? "-" : " "}
                                </span>
                                <span
                                    className={cn(
                                        "whitespace-pre-wrap break-all flex-1 pr-3",
                                        isAdded && "text-emerald-100",
                                        isRemoved && "text-rose-100",
                                        line.type === "context" && "text-slate-300",
                                    )}
                                >
                                    {line.content || "\u00A0"}
                                </span>
                            </div>
                        );
                    })}
                </pre>
            </div>
        </div>
    );
}
