"use client";

/**
 * Reusable Versions / Compare controls for a single file path.
 *
 * Drop into any file-viewer header in the Browse tab. Renders either:
 * - the normal mode: [Compare] [Versions ▾] buttons (+ "Viewing version" banner returned via render-prop pattern is omitted — embed the banner inline next to your viewer instead)
 * - the compare mode: [A ▾] [⇄] [B ▾] [✕] with a popover history list
 *
 * Returns a `body` slot via `renderBody({ singleContent, diff }) => ReactNode`
 * so the caller can decide how to render the underlying viewer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { FileCommit } from "@/lib/git-history";
import { FileDiffViewer } from "@/components/FileDiffViewer";

export type SlotRef =
    | { kind: "working"; env?: string }
    | { kind: "sha"; env?: string; sha: string; shortSha: string; isoDate: string };

/** Format a slot for display. Prefixes the env name when it differs from `defaultEnv`. */
export function slotLabel(slot: SlotRef, defaultEnv?: string): string {
    const envPart = slot.env && slot.env !== defaultEnv ? `${slot.env} · ` : "";
    if (slot.kind === "working") return `${envPart}Working tree (current)`;
    return `${envPart}${slot.shortSha} · ${new Date(slot.isoDate).toLocaleString()}`;
}

export interface VersionPickerProps {
    /** Environment name (e.g. "ide"). */
    environment: string;
    /** Full environments list — enables per-slot env override in compare mode. */
    environments?: Array<{ name: string }>;
    /** Path of the file, relative to that environment's configDir. */
    filePath: string | null;
    /** File name used to format the diff (JSON vs JS beautify). */
    fileName: string;
    /** Working-tree content for compare mode (already fetched by the caller). */
    workingContent: string | null;
    /**
     * Light theme = bright button styles for light-bg headers (e.g. journey
     * graph chrome). Dark theme = dark-bg headers (the default Browse pane).
     */
    theme?: "dark" | "light";
    /** Render the body — single-version viewer when not comparing, diff when comparing. */
    renderBody: (mode:
        | { kind: "single"; content: string | null; viewingSha: string | null; viewingShortSha: string | null; viewingDate: string | null; loading: boolean }
        | { kind: "compare"; aContent: string; bContent: string; aLabel: string; bLabel: string; loading: boolean; error?: string }
    ) => React.ReactNode;
}

export function useVersionPicker({
    environment,
    environments,
    filePath,
    fileName,
    workingContent,
    theme = "dark",
    renderBody,
}: VersionPickerProps) {
    const [historyOpen, setHistoryOpen] = useState(false);
    // Per-env cache so a slot pointing at another env can show that env's git history.
    // The non-compare Versions dropdown always reads the entry for `environment`.
    type HistorySlice = { entries: FileCommit[] | null; loading: boolean; error: string | null; gitAvailable: boolean | null };
    const [historyByEnv, setHistoryByEnv] = useState<Record<string, HistorySlice>>({});
    const currentHistory: HistorySlice = historyByEnv[environment] ?? { entries: null, loading: false, error: null, gitAvailable: null };
    const historyEntries = currentHistory.entries;
    const historyLoading = currentHistory.loading;
    const historyError = currentHistory.error;
    const gitAvailable = currentHistory.gitAvailable;
    const [viewingSha, setViewingSha] = useState<string | null>(null);
    const [viewingShortSha, setViewingShortSha] = useState<string | null>(null);
    const [viewingDate, setViewingDate] = useState<string | null>(null);
    const [versionContent, setVersionContent] = useState<string | null>(null);
    const [versionLoading, setVersionLoading] = useState(false);
    const historyDropdownRef = useRef<HTMLDivElement | null>(null);

    const [compareMode, setCompareMode] = useState(false);
    const [slotA, setSlotA] = useState<SlotRef>({ kind: "working" });
    const [slotB, setSlotB] = useState<SlotRef>({ kind: "working" });
    const [slotAContent, setSlotAContent] = useState<string | null>(null);
    const [slotBContent, setSlotBContent] = useState<string | null>(null);
    const [slotAError, setSlotAError] = useState<string | null>(null);
    const [slotBError, setSlotBError] = useState<string | null>(null);
    const [slotLoading, setSlotLoading] = useState(false);
    const [activeSlotMenu, setActiveSlotMenu] = useState<"A" | "B" | null>(null);
    // Which env's history the open slot popover is showing. Defaults to the slot's env.
    const [slotMenuEnv, setSlotMenuEnv] = useState<string>(environment);
    const slotMenuRef = useRef<HTMLDivElement | null>(null);

    // Reset all version state whenever the underlying file changes.
    useEffect(() => {
        setHistoryOpen(false);
        setHistoryByEnv({});
        setViewingSha(null);
        setViewingShortSha(null);
        setViewingDate(null);
        setVersionContent(null);
        setCompareMode(false);
        setSlotA({ kind: "working" });
        setSlotB({ kind: "working" });
        setSlotAContent(null);
        setSlotBContent(null);
        setSlotAError(null);
        setSlotBError(null);
        setActiveSlotMenu(null);
        setSlotMenuEnv(environment);
    }, [filePath, environment]);

    const loadHistoryForEnv = useCallback(async (env: string): Promise<FileCommit[]> => {
        if (!filePath) return [];
        setHistoryByEnv((prev) => ({
            ...prev,
            [env]: { ...(prev[env] ?? { entries: null, loading: false, error: null, gitAvailable: null }), loading: true, error: null },
        }));
        try {
            const res = await fetch(
                `/api/configs/${env}/file-history?path=${encodeURIComponent(filePath)}&limit=50`,
            );
            const data = await res.json();
            if (!res.ok) {
                const error = data.error ?? `HTTP ${res.status}`;
                setHistoryByEnv((prev) => ({
                    ...prev,
                    [env]: { entries: [], loading: false, error, gitAvailable: prev[env]?.gitAvailable ?? null },
                }));
                return [];
            }
            const entries = Array.isArray(data.entries) ? (data.entries as FileCommit[]) : [];
            setHistoryByEnv((prev) => ({
                ...prev,
                [env]: { entries, loading: false, error: null, gitAvailable: Boolean(data.gitAvailable) },
            }));
            return entries;
        } catch (e) {
            const error = (e as Error).message;
            setHistoryByEnv((prev) => ({
                ...prev,
                [env]: { entries: [], loading: false, error, gitAvailable: prev[env]?.gitAvailable ?? null },
            }));
            return [];
        }
    }, [filePath]);

    const loadHistory = useCallback(() => loadHistoryForEnv(environment), [loadHistoryForEnv, environment]);

    const fetchAtSha = useCallback(
        async (env: string, sha: string): Promise<{ ok: boolean; content: string; exists: boolean; error?: string }> => {
            if (!filePath) return { ok: false, content: "", exists: false, error: "No file" };
            const res = await fetch(
                `/api/configs/${env}/file-at?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(sha)}`,
            );
            const data = await res.json();
            if (!res.ok) return { ok: false, content: "", exists: false, error: data.error ?? `HTTP ${res.status}` };
            return { ok: true, content: data.content ?? "", exists: Boolean(data.exists) };
        },
        [filePath],
    );

    const handleOpenHistory = () => {
        if (historyOpen) {
            setHistoryOpen(false);
            return;
        }
        setHistoryOpen(true);
        if (historyEntries === null) void loadHistory();
    };

    const handleVersionSelect = async (entry: FileCommit) => {
        setHistoryOpen(false);
        setVersionLoading(true);
        try {
            const result = await fetchAtSha(environment, entry.sha);
            if (!result.ok) {
                setVersionContent(`// Failed to load version: ${result.error}`);
            } else if (!result.exists) {
                setVersionContent(
                    `// File did not exist at commit ${entry.shortSha} (${new Date(entry.isoDate).toLocaleString()}).`,
                );
            } else {
                setVersionContent(result.content);
            }
            setViewingSha(entry.sha);
            setViewingShortSha(entry.shortSha);
            setViewingDate(entry.isoDate);
        } finally {
            setVersionLoading(false);
        }
    };

    const handleViewCurrent = () => {
        setViewingSha(null);
        setViewingShortSha(null);
        setViewingDate(null);
        setVersionContent(null);
    };

    // Click-outside for both popovers.
    useEffect(() => {
        if (!historyOpen) return;
        const onClick = (e: MouseEvent) => {
            if (historyDropdownRef.current && !historyDropdownRef.current.contains(e.target as Node)) {
                setHistoryOpen(false);
            }
        };
        document.addEventListener("mousedown", onClick);
        return () => document.removeEventListener("mousedown", onClick);
    }, [historyOpen]);

    useEffect(() => {
        if (!activeSlotMenu) return;
        const onClick = (e: MouseEvent) => {
            if (slotMenuRef.current && !slotMenuRef.current.contains(e.target as Node)) {
                setActiveSlotMenu(null);
            }
        };
        document.addEventListener("mousedown", onClick);
        return () => document.removeEventListener("mousedown", onClick);
    }, [activeSlotMenu]);

    // Load both slot contents when compareMode or slots change.
    useEffect(() => {
        if (!compareMode || !filePath) return;
        let cancelled = false;
        setSlotLoading(true);
        setSlotAError(null);
        setSlotBError(null);
        const load = async (slot: SlotRef) => {
            const slotEnv = slot.env ?? environment;
            if (slot.kind === "working") {
                // Working-tree of the picker's `environment` is already loaded by the caller.
                if (slotEnv === environment && workingContent !== null) return { ok: true, content: workingContent };
                const r = await fetch(`/api/configs/${slotEnv}/file?path=${encodeURIComponent(filePath)}`);
                const d = await r.json();
                if (!r.ok) return { ok: false, content: "", error: d.error ?? `not present in ${slotEnv}` };
                return { ok: true, content: d.content ?? "" };
            }
            const res = await fetchAtSha(slotEnv, slot.sha);
            if (!res.ok) return { ok: false, content: "", error: res.error };
            return { ok: true, content: res.exists ? res.content : "" };
        };
        Promise.all([load(slotA), load(slotB)])
            .then(([a, b]) => {
                if (cancelled) return;
                if (!a.ok) setSlotAError(a.error ?? "Failed to load");
                setSlotAContent(a.content);
                if (!b.ok) setSlotBError(b.error ?? "Failed to load");
                setSlotBContent(b.content);
            })
            .finally(() => {
                if (!cancelled) setSlotLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [compareMode, filePath, slotA, slotB, workingContent, environment, fetchAtSha]);

    const handleEnterCompare = async () => {
        if (!filePath) return;
        setCompareMode(true);
        setSlotA({ kind: "working", env: environment });
        let entries = historyEntries;
        if (entries === null) entries = await loadHistory();
        if (entries.length > 0) {
            const newest = entries[0];
            setSlotB({ kind: "sha", env: environment, sha: newest.sha, shortSha: newest.shortSha, isoDate: newest.isoDate });
        } else {
            setSlotB({ kind: "working", env: environment });
        }
    };

    const handleExitCompare = () => {
        setCompareMode(false);
        setActiveSlotMenu(null);
        setSlotAContent(null);
        setSlotBContent(null);
        setSlotAError(null);
        setSlotBError(null);
    };

    const assignToActiveSlot = (slot: SlotRef) => {
        if (activeSlotMenu === "A") setSlotA(slot);
        else if (activeSlotMenu === "B") setSlotB(slot);
        setActiveSlotMenu(null);
    };

    // Open a slot menu and preselect that slot's env (or the current env when unset).
    const openSlotMenu = (which: "A" | "B") => {
        if (activeSlotMenu === which) { setActiveSlotMenu(null); return; }
        const slot = which === "A" ? slotA : slotB;
        const env = slot.env ?? environment;
        setSlotMenuEnv(env);
        if (filePath && historyByEnv[env]?.entries == null && !historyByEnv[env]?.loading) {
            void loadHistoryForEnv(env);
        }
        setActiveSlotMenu(which);
    };

    const handleSlotMenuEnvChange = (env: string) => {
        setSlotMenuEnv(env);
        if (filePath && historyByEnv[env]?.entries == null && !historyByEnv[env]?.loading) {
            void loadHistoryForEnv(env);
        }
    };

    const swapSlots = () => {
        setSlotA(slotB);
        setSlotB(slotA);
    };

    // ── Style tokens ───────────────────────────────────────────────────────
    const isDark = theme === "dark";
    const btnBase = cn(
        "shrink-0 px-2 py-0.5 text-[11px] font-medium rounded border transition-colors flex items-center gap-1",
        isDark
            ? "border-slate-600 bg-slate-700/40 text-slate-200 hover:bg-slate-600/40"
            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    );
    const popoverCls = cn(
        "absolute right-0 top-full mt-1 w-[28rem] max-h-96 overflow-y-auto rounded-md shadow-xl z-30",
        isDark
            ? "border border-slate-600 bg-slate-800 text-slate-200"
            : "border border-slate-200 bg-white text-slate-800",
    );

    const headerControls = filePath && gitAvailable !== false && (
        <>
            {!compareMode && (
                <button type="button" onClick={handleEnterCompare} className={btnBase} title="Compare two versions of this file">
                    Compare
                </button>
            )}
            {compareMode && (
                <div className="relative shrink-0 flex items-center gap-1" ref={slotMenuRef}>
                    <button
                        type="button"
                        onClick={() => openSlotMenu("A")}
                        className="px-2 py-0.5 text-[11px] font-medium rounded border border-rose-500/60 bg-rose-100 text-rose-800 hover:bg-rose-200 flex items-center gap-1 dark:bg-rose-900/30 dark:text-rose-100 dark:hover:bg-rose-800/40"
                        title={`A: ${slotLabel(slotA, environment)}`}
                    >
                        <span className="font-mono">A</span>
                        <span className="truncate max-w-[12rem]">
                            {slotA.env && slotA.env !== environment ? `${slotA.env} · ` : ""}
                            {slotA.kind === "working" ? "current" : slotA.shortSha}
                        </span>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                    <button type="button" onClick={swapSlots} title="Swap A and B" className={btnBase}>⇄</button>
                    <button
                        type="button"
                        onClick={() => openSlotMenu("B")}
                        className="px-2 py-0.5 text-[11px] font-medium rounded border border-emerald-500/60 bg-emerald-100 text-emerald-800 hover:bg-emerald-200 flex items-center gap-1 dark:bg-emerald-900/30 dark:text-emerald-100 dark:hover:bg-emerald-800/40"
                        title={`B: ${slotLabel(slotB, environment)}`}
                    >
                        <span className="font-mono">B</span>
                        <span className="truncate max-w-[12rem]">
                            {slotB.env && slotB.env !== environment ? `${slotB.env} · ` : ""}
                            {slotB.kind === "working" ? "current" : slotB.shortSha}
                        </span>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                    <button type="button" onClick={handleExitCompare} title="Exit compare mode" className={btnBase}>✕</button>
                    {activeSlotMenu && (
                        <div className={popoverCls}>
                            {environments && environments.length > 1 && (
                                <div className={cn(
                                    "px-3 py-2 border-b flex items-center gap-1 flex-wrap",
                                    isDark ? "border-slate-700 bg-slate-900/40" : "border-slate-200 bg-slate-50",
                                )}>
                                    <span className={cn("text-[10px] uppercase tracking-wide mr-1", isDark ? "text-slate-400" : "text-slate-500")}>Env</span>
                                    {environments.map((env) => {
                                        const active = env.name === slotMenuEnv;
                                        return (
                                            <button
                                                key={env.name}
                                                type="button"
                                                onClick={() => handleSlotMenuEnvChange(env.name)}
                                                className={cn(
                                                    "px-1.5 py-0.5 text-[10px] rounded border",
                                                    active
                                                        ? (isDark ? "border-sky-400 bg-sky-700/40 text-sky-100" : "border-sky-500 bg-sky-100 text-sky-800")
                                                        : (isDark ? "border-slate-600 hover:bg-slate-700/50" : "border-slate-300 hover:bg-slate-100"),
                                                )}
                                                title={env.name === environment ? `${env.name} (current view)` : env.name}
                                            >
                                                {env.name}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={() => assignToActiveSlot({ kind: "working", env: slotMenuEnv })}
                                className={cn(
                                    "w-full text-left px-3 py-2 text-xs border-b",
                                    isDark ? "border-slate-700 hover:bg-slate-700/60" : "border-slate-200 hover:bg-slate-50",
                                )}
                            >
                                <div className="font-medium">
                                    {slotMenuEnv !== environment ? `${slotMenuEnv} · ` : ""}Working tree (current)
                                </div>
                                <div className={cn("text-[10px]", isDark ? "text-slate-400" : "text-slate-500")}>
                                    Live file on disk{slotMenuEnv !== environment ? ` in ${slotMenuEnv}` : ""}
                                </div>
                            </button>
                            {renderHistoryRows({
                                entries: historyByEnv[slotMenuEnv]?.entries ?? null,
                                loading: historyByEnv[slotMenuEnv]?.loading ?? false,
                                error: historyByEnv[slotMenuEnv]?.error ?? null,
                                isDark,
                                activeSha: null,
                                onPick: (entry) =>
                                    assignToActiveSlot({ kind: "sha", env: slotMenuEnv, sha: entry.sha, shortSha: entry.shortSha, isoDate: entry.isoDate }),
                                otherSlotSha: activeSlotMenu === "A" ? (slotB.kind === "sha" ? slotB.sha : null) : (slotA.kind === "sha" ? slotA.sha : null),
                                otherSlotLabel: activeSlotMenu === "A" ? "B" : "A",
                            })}
                        </div>
                    )}
                </div>
            )}
            {!compareMode && (
                <div className="relative shrink-0" ref={historyDropdownRef}>
                    <button
                        type="button"
                        onClick={handleOpenHistory}
                        title="View previous versions of this file"
                        className={cn(
                            btnBase,
                            viewingSha &&
                            (isDark
                                ? "!border-amber-500 !bg-amber-700/30 !text-amber-200"
                                : "!border-amber-500 !bg-amber-100 !text-amber-800"),
                        )}
                    >
                        {viewingSha ? `@ ${viewingShortSha}` : "Versions"}
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                    {historyOpen && (
                        <div className={popoverCls}>
                            <button
                                type="button"
                                onClick={() => {
                                    setHistoryOpen(false);
                                    if (viewingSha) handleViewCurrent();
                                }}
                                className={cn(
                                    "w-full text-left px-3 py-2 text-xs border-b",
                                    isDark ? "border-slate-700 hover:bg-slate-700/60" : "border-slate-200 hover:bg-slate-50",
                                    !viewingSha && (isDark ? "bg-sky-900/30" : "bg-sky-50"),
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">Working tree (current)</span>
                                    {!viewingSha && (
                                        <span className={cn("text-[10px]", isDark ? "text-sky-300" : "text-sky-600")}>● viewing</span>
                                    )}
                                </div>
                                <div className={cn("text-[10px]", isDark ? "text-slate-400" : "text-slate-500")}>Live file on disk</div>
                            </button>
                            {renderHistoryRows({
                                entries: historyEntries,
                                loading: historyLoading,
                                error: historyError,
                                isDark,
                                activeSha: viewingSha,
                                onPick: handleVersionSelect,
                            })}
                        </div>
                    )}
                </div>
            )}
        </>
    );

    const banner = !compareMode && viewingSha && (
        <div
            className={cn(
                "px-4 py-1.5 border-b flex items-center gap-3 text-xs",
                isDark
                    ? "border-amber-700/40 bg-amber-900/30 text-amber-100"
                    : "border-amber-300 bg-amber-50 text-amber-900",
            )}
        >
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
                Viewing version <span className="font-mono">{viewingShortSha}</span>
                {viewingDate && <> from {new Date(viewingDate).toLocaleString()}</>}
            </span>
            <button
                type="button"
                onClick={handleViewCurrent}
                disabled={versionLoading}
                className={cn(
                    "ml-auto px-2 py-0.5 text-[11px] font-medium rounded border disabled:opacity-50",
                    isDark
                        ? "border-amber-600 bg-amber-800/40 hover:bg-amber-700/50"
                        : "border-amber-500 bg-amber-100 hover:bg-amber-200",
                )}
            >
                Back to current
            </button>
        </div>
    );

    // Decide body mode.
    let bodyNode: React.ReactNode = null;
    if (compareMode) {
        if (slotLoading) {
            bodyNode = renderBody({ kind: "compare", aContent: "", bContent: "", aLabel: slotLabel(slotA, environment), bLabel: slotLabel(slotB, environment), loading: true });
        } else if (slotAError || slotBError) {
            bodyNode = renderBody({
                kind: "compare",
                aContent: "",
                bContent: "",
                aLabel: slotLabel(slotA, environment),
                bLabel: slotLabel(slotB, environment),
                loading: false,
                error: slotAError ? `A: ${slotAError}` : slotBError ? `B: ${slotBError}` : undefined,
            });
        } else if (slotAContent !== null && slotBContent !== null) {
            // Caller can override; default rendering uses the unified diff viewer.
            bodyNode = renderBody({
                kind: "compare",
                aContent: slotAContent,
                bContent: slotBContent,
                aLabel: slotLabel(slotA, environment),
                bLabel: slotLabel(slotB, environment),
                loading: false,
            });
        }
    } else {
        bodyNode = renderBody({
            kind: "single",
            content: viewingSha ? versionContent : workingContent,
            viewingSha,
            viewingShortSha,
            viewingDate,
            loading: versionLoading,
        });
    }

    return { headerControls, banner, bodyNode };
}

interface HistoryRowsProps {
    entries: FileCommit[] | null;
    loading: boolean;
    error: string | null;
    isDark: boolean;
    activeSha: string | null;
    onPick: (entry: FileCommit) => void;
    otherSlotSha?: string | null;
    otherSlotLabel?: string;
}

function renderHistoryRows({ entries, loading, error, isDark, activeSha, onPick, otherSlotSha, otherSlotLabel }: HistoryRowsProps) {
    if (loading) return <div className={cn("px-3 py-3 text-xs", isDark ? "text-slate-400" : "text-slate-500")}>Loading history…</div>;
    if (error) return <div className="px-3 py-3 text-xs text-rose-500">{error}</div>;
    if (entries && entries.length === 0) {
        return <div className={cn("px-3 py-3 text-xs", isDark ? "text-slate-400" : "text-slate-500")}>No earlier versions in git.</div>;
    }
    return entries?.map((entry) => {
        const isActive = activeSha === entry.sha;
        const inOther = otherSlotSha === entry.sha;
        return (
            <button
                key={entry.sha}
                type="button"
                onClick={() => onPick(entry)}
                className={cn(
                    "w-full text-left px-3 py-2 text-xs border-t transition-colors",
                    isDark
                        ? "border-slate-700/60 hover:bg-slate-700/60"
                        : "border-slate-200 hover:bg-slate-50",
                    isActive && (isDark ? "bg-amber-900/30" : "bg-amber-50"),
                )}
            >
                <div className="flex items-center gap-2">
                    <span
                        className={cn(
                            "shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider",
                            entry.opKind === "pull" && (isDark ? "bg-sky-900/60 text-sky-200" : "bg-sky-100 text-sky-800"),
                            entry.opKind === "push" && (isDark ? "bg-emerald-900/60 text-emerald-200" : "bg-emerald-100 text-emerald-800"),
                            entry.opKind === "promote" && (isDark ? "bg-purple-900/60 text-purple-200" : "bg-purple-100 text-purple-800"),
                            entry.opKind === "manual" && (isDark ? "bg-slate-700 text-slate-200" : "bg-slate-100 text-slate-700"),
                            entry.opKind === "auto" && (isDark ? "bg-amber-900/60 text-amber-200" : "bg-amber-100 text-amber-800"),
                            entry.opKind === "merge" && (isDark ? "bg-indigo-900/60 text-indigo-200" : "bg-indigo-100 text-indigo-800"),
                            entry.opKind === "other" && (isDark ? "bg-slate-700 text-slate-300" : "bg-slate-100 text-slate-600"),
                        )}
                    >
                        {entry.opKind}
                    </span>
                    <span className={cn("font-mono", isDark ? "text-slate-400" : "text-slate-600")}>{entry.shortSha}</span>
                    <span className={cn(isDark ? "text-slate-500" : "text-slate-400")}>·</span>
                    <span className={cn(isDark ? "text-slate-400" : "text-slate-600")}>{new Date(entry.isoDate).toLocaleString()}</span>
                    {isActive && <span className={cn("ml-auto text-[10px]", isDark ? "text-amber-300" : "text-amber-700")}>● viewing</span>}
                    {!isActive && inOther && otherSlotLabel && (
                        <span className={cn("ml-auto text-[10px] font-mono", isDark ? "text-amber-300" : "text-amber-700")}>in {otherSlotLabel}</span>
                    )}
                </div>
                <div className={cn("mt-0.5 truncate", isDark ? "text-slate-300" : "text-slate-700")} title={entry.subject}>
                    {entry.subject.length > 120 ? entry.subject.slice(0, 117) + "…" : entry.subject}
                </div>
                <div className={cn("text-[10px] truncate", isDark ? "text-slate-500" : "text-slate-500")}>{entry.author}</div>
            </button>
        );
    });
}

/** Convenience default-diff body when the caller doesn't need a custom one. */
export function DefaultCompareBody({
    aContent,
    bContent,
    aLabel,
    bLabel,
    fileName,
    loading,
    error,
}: {
    aContent: string;
    bContent: string;
    aLabel: string;
    bLabel: string;
    fileName: string;
    loading: boolean;
    error?: string;
}) {
    if (loading) {
        return <div className="flex items-center justify-center h-full text-sm text-slate-500">Loading diff…</div>;
    }
    if (error) {
        return <div className="p-4 text-xs text-rose-500">{error}</div>;
    }
    return <FileDiffViewer aContent={aContent} bContent={bContent} aLabel={aLabel} bLabel={bLabel} fileName={fileName} />;
}
