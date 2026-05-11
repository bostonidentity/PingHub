"use client";

/**
 * Browse → Compare control for journeys and IGA workflows.
 *
 * These scopes are multi-file items (a journey is a directory of node JSONs
 * plus inner-journey references and scripts; a workflow has steps), so the
 * per-file Compare button doesn't make sense. Instead, this panel:
 *
 *   1. Lists commits that touched ANY file in the item's directory
 *      (`/api/configs/[env]/item-history`).
 *   2. Lets the user pick A and B (working tree or any past commit).
 *   3. Hits `/api/configs/[env]/item-compare` which materialises both
 *      commits as git worktrees and runs the same `buildReport` engine
 *      the Compare page uses, scoped to the selected item.
 *   4. Opens the matching graph modal (`JourneyDiffGraphModal` or
 *      `WorkflowDiffGraphModal`) so the diff is rendered in the existing
 *      unified-view experience.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { FileCommit } from "@/lib/git-history";
import type { CompareReport, FileDiff, JourneyTreeNode } from "@/lib/diff-types";
import { JourneyDiffGraphModal } from "@/app/compare/JourneyDiffGraph";
import { WorkflowDiffGraphModal } from "@/app/compare/WorkflowDiffGraph";

type Scope = "journeys" | "iga-workflows";

type SlotRef =
    | { kind: "working" }
    | { kind: "sha"; sha: string; shortSha: string; isoDate: string };

function slotLabel(slot: SlotRef): string {
    if (slot.kind === "working") return "Working tree";
    return `${slot.shortSha} · ${new Date(slot.isoDate).toLocaleString()}`;
}

function slotBadge(slot: SlotRef): string {
    return slot.kind === "working" ? "current" : slot.shortSha;
}

export interface ItemComparePanelProps {
    environment: string;
    scope: Scope;
    item: string;
    itemLabel: string;
}

export function ItemComparePanel({ environment, scope, item, itemLabel }: ItemComparePanelProps) {
    const [historyEntries, setHistoryEntries] = useState<FileCommit[] | null>(null);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [gitAvailable, setGitAvailable] = useState<boolean | null>(null);

    const [panelOpen, setPanelOpen] = useState(false);
    const [slotA, setSlotA] = useState<SlotRef>({ kind: "working" });
    const [slotB, setSlotB] = useState<SlotRef>({ kind: "working" });
    const [activeSlotMenu, setActiveSlotMenu] = useState<"A" | "B" | null>(null);

    const [running, setRunning] = useState(false);
    const [report, setReport] = useState<CompareReport | null>(null);
    const [error, setError] = useState<string | null>(null);

    const panelRef = useRef<HTMLDivElement | null>(null);

    // Reset whenever the item changes.
    useEffect(() => {
        setPanelOpen(false);
        setSlotA({ kind: "working" });
        setSlotB({ kind: "working" });
        setActiveSlotMenu(null);
        setReport(null);
        setError(null);
        setHistoryEntries(null);
        setHistoryError(null);
    }, [environment, scope, item]);

    const loadHistory = useCallback(async (): Promise<FileCommit[]> => {
        setHistoryLoading(true);
        setHistoryError(null);
        try {
            const res = await fetch(
                `/api/configs/${environment}/item-history?scope=${encodeURIComponent(scope)}&item=${encodeURIComponent(item)}&limit=50`,
            );
            const data = await res.json();
            if (!res.ok) {
                setHistoryError(data.error ?? `HTTP ${res.status}`);
                setHistoryEntries([]);
                return [];
            }
            setGitAvailable(Boolean(data.gitAvailable));
            const entries = Array.isArray(data.entries) ? (data.entries as FileCommit[]) : [];
            setHistoryEntries(entries);
            return entries;
        } catch (e) {
            setHistoryError((e as Error).message);
            setHistoryEntries([]);
            return [];
        } finally {
            setHistoryLoading(false);
        }
    }, [environment, scope, item]);

    const handleOpenPanel = async () => {
        if (panelOpen) {
            setPanelOpen(false);
            return;
        }
        setPanelOpen(true);
        let entries = historyEntries;
        if (entries === null) entries = await loadHistory();
        // Default: A = oldest-known commit if any (so the diff shows
        // "from X to current"), B = working tree.
        if (entries.length > 0 && slotA.kind === "working") {
            const newest = entries[0];
            setSlotA({ kind: "sha", sha: newest.sha, shortSha: newest.shortSha, isoDate: newest.isoDate });
        }
    };

    // Close on click-outside.
    useEffect(() => {
        if (!panelOpen) return;
        const onClick = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setPanelOpen(false);
                setActiveSlotMenu(null);
            }
        };
        document.addEventListener("mousedown", onClick);
        return () => document.removeEventListener("mousedown", onClick);
    }, [panelOpen]);

    const assignToActiveSlot = (slot: SlotRef) => {
        if (activeSlotMenu === "A") setSlotA(slot);
        else if (activeSlotMenu === "B") setSlotB(slot);
        setActiveSlotMenu(null);
    };

    const swapSlots = () => {
        setSlotA(slotB);
        setSlotB(slotA);
    };

    const runCompare = async () => {
        if (slotA.kind === "working" && slotB.kind === "working") {
            setError("Pick at least one historical version to compare.");
            return;
        }
        setError(null);
        setRunning(true);
        try {
            const res = await fetch(`/api/configs/${environment}/item-compare`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    scope,
                    item,
                    shaA: slotA.kind === "working" ? "working" : slotA.sha,
                    shaB: slotB.kind === "working" ? "working" : slotB.sha,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? `HTTP ${res.status}`);
                return;
            }
            setReport(data as CompareReport);
            setPanelOpen(false);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setRunning(false);
        }
    };

    // ── Modal selection ─────────────────────────────────────────────────────
    let modal: React.ReactNode = null;
    if (report) {
        const sourceLabel = `${environment} @ ${slotA.kind === "working" ? "current" : slotA.shortSha}`;
        const targetLabel = `${environment} @ ${slotB.kind === "working" ? "current" : slotB.shortSha}`;
        if (scope === "iga-workflows") {
            const workflowFiles: FileDiff[] = report.files;
            modal = (
                <WorkflowDiffGraphModal
                    workflowName={itemLabel}
                    workflowFiles={workflowFiles}
                    sourceLabel={sourceLabel}
                    targetLabel={targetLabel}
                    onClose={() => setReport(null)}
                />
            );
        } else {
            // Journeys — find the matching tree node.
            const tree: JourneyTreeNode[] = report.journeyTree ?? [];
            const node = tree.find((n) => n.name === item) ?? tree[0];
            const journeyFile = report.files.find((f) =>
                f.relativePath.endsWith(`/journeys/${item}/${item}.json`),
            );
            if (!node) {
                // Engine returned no tree (file unchanged?) — surface a
                // graceful fallback instead of opening an empty graph.
                modal = (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                        onClick={() => setReport(null)}
                    >
                        <div
                            className="bg-white rounded-lg shadow-xl border border-slate-200 p-6 max-w-md text-sm text-slate-700"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="font-semibold mb-2">No changes detected</div>
                            <p>
                                The two versions of <span className="font-mono">{itemLabel}</span> are
                                semantically equal between {sourceLabel} and {targetLabel}.
                            </p>
                            <button
                                type="button"
                                onClick={() => setReport(null)}
                                className="mt-4 px-3 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                );
            } else {
                modal = (
                    <JourneyDiffGraphModal
                        journeyName={node.name}
                        localContent={journeyFile?.localContent}
                        remoteContent={journeyFile?.remoteContent}
                        nodeInfos={node.nodes}
                        sourceLabel={sourceLabel}
                        targetLabel={targetLabel}
                        sourceEnv={environment}
                        targetEnv={environment}
                        files={report.files}
                        journeyTree={[node]}
                        onClose={() => setReport(null)}
                    />
                );
            }
        }
    }

    const btnBase =
        "shrink-0 px-2 py-0.5 text-[11px] font-medium rounded border transition-colors flex items-center gap-1 border-slate-300 bg-white text-slate-700 hover:bg-slate-50";

    return (
        <>
            <div className="relative shrink-0" ref={panelRef}>
                <button
                    type="button"
                    onClick={handleOpenPanel}
                    className={btnBase}
                    title="Compare two versions of this item"
                    disabled={running}
                >
                    {running ? "Comparing…" : "Compare versions"}
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </button>

                {panelOpen && (
                    <div className="absolute right-0 top-full mt-1 w-[24rem] bg-white border border-slate-200 rounded-md shadow-xl z-30 p-3">
                        <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">
                            Compare {scope === "journeys" ? "journey" : "workflow"} versions
                        </div>

                        {gitAvailable === false ? (
                            <p className="text-xs text-amber-700">
                                Env-repo isn't a git repository — version history isn't available.
                            </p>
                        ) : historyError ? (
                            <p className="text-xs text-rose-600">{historyError}</p>
                        ) : (
                            <>
                                {/* Slot A */}
                                <div className="mb-2">
                                    <div className="text-[10px] uppercase tracking-wider text-rose-700 font-semibold mb-1">A</div>
                                    <button
                                        type="button"
                                        onClick={() => setActiveSlotMenu(activeSlotMenu === "A" ? null : "A")}
                                        className="w-full text-left px-2 py-1.5 text-xs rounded border border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 flex items-center justify-between"
                                    >
                                        <span className="truncate">{slotLabel(slotA)}</span>
                                        <span className="font-mono text-[10px] ml-2 shrink-0">{slotBadge(slotA)}</span>
                                    </button>
                                </div>

                                <button
                                    type="button"
                                    onClick={swapSlots}
                                    className="mx-auto my-1 block text-slate-400 hover:text-slate-700 text-xs"
                                    title="Swap A and B"
                                >
                                    ⇅ swap
                                </button>

                                {/* Slot B */}
                                <div className="mb-3">
                                    <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold mb-1">B</div>
                                    <button
                                        type="button"
                                        onClick={() => setActiveSlotMenu(activeSlotMenu === "B" ? null : "B")}
                                        className="w-full text-left px-2 py-1.5 text-xs rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 flex items-center justify-between"
                                    >
                                        <span className="truncate">{slotLabel(slotB)}</span>
                                        <span className="font-mono text-[10px] ml-2 shrink-0">{slotBadge(slotB)}</span>
                                    </button>
                                </div>

                                {activeSlotMenu && (
                                    <div className="mb-3 max-h-64 overflow-y-auto border border-slate-200 rounded">
                                        <button
                                            type="button"
                                            onClick={() => assignToActiveSlot({ kind: "working" })}
                                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 border-b border-slate-100"
                                        >
                                            <div className="font-medium">Working tree (current)</div>
                                            <div className="text-[10px] text-slate-500">Live files on disk</div>
                                        </button>
                                        {historyLoading ? (
                                            <div className="px-3 py-2 text-[11px] text-slate-500">Loading history…</div>
                                        ) : historyEntries && historyEntries.length === 0 ? (
                                            <div className="px-3 py-2 text-[11px] text-slate-500">No earlier versions.</div>
                                        ) : (
                                            historyEntries?.map((entry) => (
                                                <button
                                                    key={entry.sha}
                                                    type="button"
                                                    onClick={() =>
                                                        assignToActiveSlot({
                                                            kind: "sha",
                                                            sha: entry.sha,
                                                            shortSha: entry.shortSha,
                                                            isoDate: entry.isoDate,
                                                        })
                                                    }
                                                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 border-b border-slate-100"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <OpKindBadge kind={entry.opKind} />
                                                        <span className="font-mono text-slate-600">{entry.shortSha}</span>
                                                        <span className="text-slate-400">·</span>
                                                        <span className="text-slate-600 text-[10px]">
                                                            {new Date(entry.isoDate).toLocaleString()}
                                                        </span>
                                                    </div>
                                                    <div
                                                        className="mt-0.5 truncate text-slate-700"
                                                        title={entry.subject}
                                                    >
                                                        {entry.subject.length > 80 ? entry.subject.slice(0, 77) + "…" : entry.subject}
                                                    </div>
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}

                                {error && (
                                    <p className="mb-2 text-xs text-rose-600">{error}</p>
                                )}

                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={runCompare}
                                        disabled={running || (slotA.kind === "working" && slotB.kind === "working")}
                                        className={cn(
                                            "px-3 py-1.5 text-xs font-medium rounded text-white",
                                            running || (slotA.kind === "working" && slotB.kind === "working")
                                                ? "bg-slate-300 cursor-not-allowed"
                                                : "bg-sky-600 hover:bg-sky-700",
                                        )}
                                    >
                                        {running ? "Comparing…" : "Run compare"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPanelOpen(false)}
                                        className="px-3 py-1.5 text-xs rounded border border-slate-300 hover:bg-slate-50"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>

            {modal}
        </>
    );
}

function OpKindBadge({ kind }: { kind: FileCommit["opKind"] }) {
    const cls =
        kind === "pull" ? "bg-sky-100 text-sky-800" :
            kind === "push" ? "bg-emerald-100 text-emerald-800" :
                kind === "promote" ? "bg-purple-100 text-purple-800" :
                    kind === "manual" ? "bg-slate-100 text-slate-700" :
                        kind === "auto" ? "bg-amber-100 text-amber-800" :
                            kind === "merge" ? "bg-indigo-100 text-indigo-800" :
                                "bg-slate-100 text-slate-600";
    return (
        <span className={cn("shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider", cls)}>
            {kind}
        </span>
    );
}
