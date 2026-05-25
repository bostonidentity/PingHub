"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Environment, CONFIG_SCOPES, ConfigScope } from "@/lib/fr-config-types";
import { FileNode } from "@/app/api/configs/[env]/route";
import type { ViewableFile } from "@/app/api/push/item/route";
import type { AuditItem } from "@/app/api/push/audit/route";
import type { EndpointUsageRef } from "@/app/api/analyze/endpoint-usage/route";
import { cn } from "@/lib/utils";
import { FileContentViewer } from "@/components/FileContentViewer";
import { JsonFileViewer } from "@/components/JsonFileViewer";
import { ScriptFileViewer, type NavigateTarget } from "@/components/ScriptFileViewer";
import { EsvDisplayToggle } from "@/components/EsvDisplayToggle";
import { useEsvDisplayMode, isEsvScope, applyEsvDecoding } from "@/lib/esv-decode";
import { JourneyGraph } from "./JourneyGraph";
import type { FileCommit } from "@/lib/git-history";
import { FileDiffViewer } from "@/components/FileDiffViewer";
import { useVersionPicker, DefaultCompareBody } from "@/components/VersionPicker";
import { ItemComparePanel } from "@/components/ItemComparePanel";

// ── Compare-mode slot reference ────────────────────────────────────────────
// Each slot is either the live working-tree file or a specific commit.
type SlotRef =
  | { kind: "working" }
  | { kind: "sha"; sha: string; shortSha: string; isoDate: string };

function slotLabel(slot: SlotRef): string {
  if (slot.kind === "working") return "Working tree (current)";
  return `${slot.shortSha} · ${new Date(slot.isoDate).toLocaleString()}`;
}
import { WorkflowGraph } from "./WorkflowGraph";
import { ManagedObjectUsagePanel, type Hit as ManagedObjectHit } from "@/app/data/browse/ManagedObjectUsagePanel";

function FullscreenButton({ fullscreen, onToggle, dark }: { fullscreen: boolean; onToggle: () => void; dark?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
      className={cn(
        "shrink-0 p-1 rounded transition-colors",
        dark
          ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
          : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
      )}
    >
      {fullscreen ? (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
        </svg>
      )}
    </button>
  );
}

function FileContent({ content, fileName, highlightLine, wrap }: { content: string; fileName: string; highlightLine?: number; wrap?: boolean }) {
  return <FileContentViewer content={content} fileName={fileName} highlightLine={highlightLine} wrap={wrap} />;
}

function WrapButton({ wrap, onToggle }: { wrap: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={wrap ? "Disable line wrap" : "Enable line wrap"}
      aria-pressed={wrap}
      className={cn(
        "shrink-0 px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
        wrap
          ? "bg-sky-900/40 text-sky-300 hover:bg-sky-900/60"
          : "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
      )}
    >
      Wrap
    </button>
  );
}

/** Derive the ESV name (e.g. "ad-external-basedn") from an esvs/{variables|secrets}/... path. */
function esvNameFromPath(relPath: string | null): { name: string; kind: "variable" | "secret" } | null {
  if (!relPath) return null;
  const norm = relPath.replace(/\\/g, "/");
  let kind: "variable" | "secret";
  if (norm.startsWith("esvs/variables/")) kind = "variable";
  else if (norm.startsWith("esvs/secrets/")) kind = "secret";
  else return null;
  const file = norm.split("/").pop() ?? "";
  const base = file
    .replace(/\.variable\.json$/i, "")
    .replace(/\.secret\.json$/i, "")
    .replace(/\.json$/i, "");
  let n = base.toLowerCase();
  if (n.startsWith("esv-")) n = n.slice(4);
  else if (n.startsWith("esv.")) n = n.slice(4);
  n = n.replace(/\./g, "-");
  if (!n) return null;
  return { name: n, kind };
}

interface UsageRef { path: string; line: number; snippet: string; form: string }

// ── File tree view ────────────────────────────────────────────────────────────

function FileTreeNode({
  node, selectedFile, onSelect, depth,
}: {
  node: FileNode; selectedFile: string | null;
  onSelect: (path: string, name: string) => void; depth: number;
}) {
  const [open, setOpen] = useState(depth < 1);

  if (node.type === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded transition-colors"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <svg className={cn("w-3 h-3 shrink-0 transition-transform text-slate-400", open && "rotate-90")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <svg className="w-3.5 h-3.5 shrink-0 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <FileTreeNode key={child.relativePath} node={child} selectedFile={selectedFile} onSelect={onSelect} depth={depth + 1} />
        ))}
      </div>
    );
  }

  const isSelected = selectedFile === node.relativePath;
  return (
    <button
      onClick={() => onSelect(node.relativePath, node.name)}
      className={cn(
        "flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs rounded transition-colors truncate",
        isSelected ? "bg-sky-100 text-sky-800 font-medium" : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
      )}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <svg className="w-3.5 h-3.5 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function TreeView({ environment }: { environment: string }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [configDir, setConfigDir] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [highlightLine, setHighlightLine] = useState<number | undefined>(undefined);
  const [usagesOpen, setUsagesOpen] = useState(false);
  const [usagesLoading, setUsagesLoading] = useState(false);
  const [usages, setUsages] = useState<UsageRef[] | null>(null);
  const [usagesError, setUsagesError] = useState<string | null>(null);
  // ── File version history (Versions dropdown) ─────────────────────────────
  // Lazy-loaded the first time the user opens the dropdown for a given file.
  // `viewingSha` is null when the working-tree (current) version is shown;
  // setting it swaps the viewer content to the file as it existed at that sha.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<FileCommit[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null);
  const [viewingSha, setViewingSha] = useState<string | null>(null);
  const [viewingShortSha, setViewingShortSha] = useState<string | null>(null);
  const [viewingDate, setViewingDate] = useState<string | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);
  // ── Compare mode (Phase 2) ──────────────────────────────────────
  // Two slots A and B. The same history list backs both pickers.
  const [compareMode, setCompareMode] = useState(false);
  const [slotA, setSlotA] = useState<SlotRef>({ kind: "working" });
  const [slotB, setSlotB] = useState<SlotRef>({ kind: "working" });
  const [slotAContent, setSlotAContent] = useState<string | null>(null);
  const [slotBContent, setSlotBContent] = useState<string | null>(null);
  const [slotAError, setSlotAError] = useState<string | null>(null);
  const [slotBError, setSlotBError] = useState<string | null>(null);
  const [slotLoading, setSlotLoading] = useState(false);
  const [activeSlotMenu, setActiveSlotMenu] = useState<"A" | "B" | null>(null);
  const slotMenuRef = useRef<HTMLDivElement | null>(null);
  const esvMeta = esvNameFromPath(selectedFile);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!environment) return;
    setTreeLoading(true);
    setTree([]);
    setSelectedFile(null);
    setFileContent(null);
    fetch(`/api/configs/${environment}`)
      .then((r) => r.json())
      .then((data) => { setTree(data.tree ?? []); setConfigDir(data.configDir ?? ""); })
      .finally(() => setTreeLoading(false));
  }, [environment]);

  // Quiet refresh on window focus / tab visibility so the tree reflects
  // external mutations (e.g. a pull run in another tab) without forcing a
  // full re-select or clearing the visible file content.
  useEffect(() => {
    if (!environment) return;
    const refresh = () => {
      fetch(`/api/configs/${environment}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => { if (data) { setTree(data.tree ?? []); setConfigDir(data.configDir ?? ""); } })
        .catch(() => { });
    };
    const onFocus = () => refresh();
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [environment]);

  const handleFileSelect = async (relativePath: string, name: string, line?: number) => {
    setSelectedFile(relativePath);
    setSelectedFileName(name);
    setFileContent(null);
    setFileLoading(true);
    setHighlightLine(line);
    // Reset version-history state for the new file. Entries are reloaded
    // lazily the next time the user opens the Versions dropdown.
    setHistoryOpen(false);
    setHistoryEntries(null);
    setHistoryError(null);
    setViewingSha(null);
    setViewingShortSha(null);
    setViewingDate(null);
    // Reset compare mode when switching files (compare is a per-file thing).
    setCompareMode(false);
    setSlotA({ kind: "working" });
    setSlotB({ kind: "working" });
    setSlotAContent(null);
    setSlotBContent(null);
    setSlotAError(null);
    setSlotBError(null);
    setActiveSlotMenu(null);
    // Clear cross-file usages state whenever the user changes file through
    // the tree click (not through a usage click).
    if (line === undefined) {
      setUsagesOpen(false);
      setUsages(null);
      setUsagesError(null);
    }
    try {
      const res = await fetch(`/api/configs/${environment}/file?path=${encodeURIComponent(relativePath)}`);
      const data = await res.json();
      setFileContent(data.content ?? "");
    } finally {
      setFileLoading(false);
    }
  };

  const handleFindUsages = async () => {
    if (!esvMeta) return;
    setUsagesOpen(true);
    setUsagesLoading(true);
    setUsages(null);
    setUsagesError(null);
    try {
      const res = await fetch(`/api/analyze/esv-usages?env=${encodeURIComponent(environment)}&name=${encodeURIComponent(esvMeta.name)}`);
      const data = await res.json();
      if (!res.ok) { setUsagesError(data.error ?? `HTTP ${res.status}`); return; }
      setUsages(data.references as UsageRef[]);
    } catch (e) {
      setUsagesError((e as Error).message);
    } finally {
      setUsagesLoading(false);
    }
  };

  const openReference = (ref: UsageRef) => {
    const basename = ref.path.split("/").pop() ?? ref.path;
    handleFileSelect(ref.path, basename, ref.line);
  };

  // ── Version history ─────────────────────────────────────────────────────
  // Lazy load on dropdown open. The first response also tells us whether the
  // env-repo is a git repo at all (if not, the dropdown stays hidden on
  // subsequent renders).
  const loadHistory = useCallback(async () => {
    if (!selectedFile) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch(
        `/api/configs/${environment}/file-history?path=${encodeURIComponent(selectedFile)}&limit=50`,
      );
      const data = await res.json();
      if (!res.ok) {
        setHistoryError(data.error ?? `HTTP ${res.status}`);
        setHistoryEntries([]);
        return;
      }
      setGitAvailable(Boolean(data.gitAvailable));
      setHistoryEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (e) {
      setHistoryError((e as Error).message);
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [environment, selectedFile]);

  const handleOpenHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (historyEntries === null) void loadHistory();
  };

  // Switch the right pane to a historical version of the current file.
  const handleVersionSelect = async (entry: FileCommit) => {
    if (!selectedFile) return;
    setHistoryOpen(false);
    setVersionLoading(true);
    setFileLoading(true);
    setHighlightLine(undefined);
    try {
      const res = await fetch(
        `/api/configs/${environment}/file-at?path=${encodeURIComponent(selectedFile)}&sha=${encodeURIComponent(entry.sha)}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setFileContent(`// Failed to load version: ${data.error ?? `HTTP ${res.status}`}`);
      } else if (!data.exists) {
        setFileContent(
          `// File did not exist at commit ${entry.shortSha} (${new Date(entry.isoDate).toLocaleString()}).`,
        );
      } else {
        setFileContent(data.content ?? "");
      }
      setViewingSha(entry.sha);
      setViewingShortSha(entry.shortSha);
      setViewingDate(entry.isoDate);
    } catch (e) {
      setFileContent(`// Failed to load version: ${(e as Error).message}`);
    } finally {
      setVersionLoading(false);
      setFileLoading(false);
    }
  };

  // Restore the working-tree (current on-disk) version.
  const handleViewCurrent = async () => {
    if (!selectedFile) return;
    setViewingSha(null);
    setViewingShortSha(null);
    setViewingDate(null);
    setVersionLoading(true);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/configs/${environment}/file?path=${encodeURIComponent(selectedFile)}`);
      const data = await res.json();
      setFileContent(data.content ?? "");
    } finally {
      setVersionLoading(false);
      setFileLoading(false);
    }
  };

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!historyOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        historyDropdownRef.current &&
        !historyDropdownRef.current.contains(e.target as Node)
      ) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [historyOpen]);

  // Same click-outside behaviour for the compare slot menus.
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

  // ── Compare slot loaders ────────────────────────────────────────────────
  // Fetch content for a single slot and store it (or an error string).
  const fetchSlotContent = useCallback(
    async (slot: SlotRef): Promise<{ ok: boolean; content: string; error?: string }> => {
      if (!selectedFile) return { ok: false, content: "", error: "No file selected" };
      if (slot.kind === "working") {
        const res = await fetch(`/api/configs/${environment}/file?path=${encodeURIComponent(selectedFile)}`);
        const data = await res.json();
        if (!res.ok) return { ok: false, content: "", error: data.error ?? `HTTP ${res.status}` };
        return { ok: true, content: data.content ?? "" };
      }
      const res = await fetch(
        `/api/configs/${environment}/file-at?path=${encodeURIComponent(selectedFile)}&sha=${encodeURIComponent(slot.sha)}`,
      );
      const data = await res.json();
      if (!res.ok) return { ok: false, content: "", error: data.error ?? `HTTP ${res.status}` };
      if (!data.exists) {
        return { ok: true, content: "", error: undefined };
      }
      return { ok: true, content: data.content ?? "" };
    },
    [environment, selectedFile],
  );

  // Re-fetch both slots whenever they (or the selected file) change while in
  // compare mode. Runs in parallel.
  useEffect(() => {
    if (!compareMode || !selectedFile) return;
    let cancelled = false;
    setSlotLoading(true);
    setSlotAError(null);
    setSlotBError(null);
    Promise.all([fetchSlotContent(slotA), fetchSlotContent(slotB)])
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
  }, [compareMode, selectedFile, slotA, slotB, fetchSlotContent]);

  // Enter compare mode. Default B to the newest historical commit if we
  // have one cached; otherwise leave both as Working (no diff yet) and the
  // user picks B explicitly.
  const handleEnterCompare = async () => {
    if (!selectedFile) return;
    setCompareMode(true);
    setSlotA({ kind: "working" });
    let entries = historyEntries;
    if (entries === null) {
      // Reuse loadHistory but await it via direct fetch so we get the result.
      setHistoryLoading(true);
      try {
        const res = await fetch(
          `/api/configs/${environment}/file-history?path=${encodeURIComponent(selectedFile)}&limit=50`,
        );
        const data = await res.json();
        if (res.ok) {
          setGitAvailable(Boolean(data.gitAvailable));
          entries = Array.isArray(data.entries) ? data.entries : [];
          setHistoryEntries(entries);
        } else {
          entries = [];
          setHistoryEntries([]);
          setHistoryError(data.error ?? `HTTP ${res.status}`);
        }
      } catch (e) {
        entries = [];
        setHistoryEntries([]);
        setHistoryError((e as Error).message);
      } finally {
        setHistoryLoading(false);
      }
    }
    if (entries && entries.length > 0) {
      const newest = entries[0];
      setSlotB({
        kind: "sha",
        sha: newest.sha,
        shortSha: newest.shortSha,
        isoDate: newest.isoDate,
      });
    } else {
      setSlotB({ kind: "working" });
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

  // Assign a history entry (or Working) to whichever slot is currently active.
  const assignToActiveSlot = (slot: SlotRef) => {
    if (activeSlotMenu === "A") setSlotA(slot);
    else if (activeSlotMenu === "B") setSlotB(slot);
    setActiveSlotMenu(null);
  };

  const swapSlots = () => {
    setSlotA(slotB);
    setSlotB(slotA);
  };

  const fileCount = countFiles(tree);

  return (
    <div className="flex gap-6 flex-1 min-h-0">
      {/* Left panel */}
      <div className="w-72 shrink-0 flex flex-col bg-white rounded-lg border border-slate-200 overflow-hidden">
        {configDir && (
          <div className="px-3 py-2 border-b border-slate-100">
            <p className="text-[10px] text-slate-400 font-mono truncate" title={configDir}>{configDir}</p>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-1">
          {treeLoading && <p className="text-xs text-slate-400 text-center py-6">Loading…</p>}
          {!treeLoading && tree.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-6 px-3">No config files found. Pull from this environment first.</p>
          )}
          {!treeLoading && tree.map((node) => (
            <FileTreeNode key={node.relativePath} node={node} selectedFile={selectedFile} onSelect={handleFileSelect} depth={0} />
          ))}
        </div>
        {fileCount > 0 && (
          <div className="px-3 py-2 border-t border-slate-100 text-[10px] text-slate-400">
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Right panel */}
      <div className={cn(
        "flex flex-col bg-slate-900 overflow-hidden",
        fullscreen ? "fixed inset-0 z-50 rounded-none border-0" : "flex-1 rounded-lg border border-slate-200"
      )}>
        {selectedFile ? (
          <>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700 bg-slate-800 shrink-0">
              <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-xs font-mono text-slate-300 truncate flex-1">{selectedFile}</span>
              {gitAvailable !== false && !compareMode && (
                <button
                  type="button"
                  onClick={handleEnterCompare}
                  title="Compare two versions of this file"
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium rounded border border-slate-600 bg-slate-700/40 text-slate-200 hover:bg-slate-600/40 transition-colors"
                >
                  Compare
                </button>
              )}
              {compareMode && (
                <div className="relative shrink-0 flex items-center gap-1" ref={slotMenuRef}>
                  <button
                    type="button"
                    onClick={() => setActiveSlotMenu(activeSlotMenu === "A" ? null : "A")}
                    className="px-2 py-0.5 text-[11px] font-medium rounded border border-rose-600/60 bg-rose-900/30 text-rose-100 hover:bg-rose-800/40 flex items-center gap-1"
                    title={`A: ${slotLabel(slotA)}`}
                  >
                    <span className="font-mono">A</span>
                    <span className="truncate max-w-[10rem]">
                      {slotA.kind === "working" ? "current" : slotA.shortSha}
                    </span>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={swapSlots}
                    title="Swap A and B"
                    className="px-1.5 py-0.5 text-[11px] rounded border border-slate-600 bg-slate-700/40 text-slate-300 hover:bg-slate-600/40"
                  >
                    ⇄
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveSlotMenu(activeSlotMenu === "B" ? null : "B")}
                    className="px-2 py-0.5 text-[11px] font-medium rounded border border-emerald-600/60 bg-emerald-900/30 text-emerald-100 hover:bg-emerald-800/40 flex items-center gap-1"
                    title={`B: ${slotLabel(slotB)}`}
                  >
                    <span className="font-mono">B</span>
                    <span className="truncate max-w-[10rem]">
                      {slotB.kind === "working" ? "current" : slotB.shortSha}
                    </span>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={handleExitCompare}
                    title="Exit compare mode"
                    className="ml-1 px-2 py-0.5 text-[11px] font-medium rounded border border-slate-600 bg-slate-700/40 text-slate-300 hover:bg-slate-600/40"
                  >
                    ✕
                  </button>
                  {activeSlotMenu && (
                    <div className="absolute right-0 top-full mt-1 w-[28rem] max-h-96 overflow-y-auto rounded-md border border-slate-600 bg-slate-800 shadow-xl z-30 text-slate-200">
                      <button
                        type="button"
                        onClick={() => assignToActiveSlot({ kind: "working" })}
                        className="w-full text-left px-3 py-2 text-xs border-b border-slate-700 hover:bg-slate-700/60"
                      >
                        <div className="font-medium">Working tree (current)</div>
                        <div className="text-[10px] text-slate-400">Live file on disk</div>
                      </button>
                      {historyLoading && (
                        <div className="px-3 py-3 text-xs text-slate-400">Loading history…</div>
                      )}
                      {historyError && (
                        <div className="px-3 py-3 text-xs text-rose-400">{historyError}</div>
                      )}
                      {!historyLoading && !historyError && historyEntries && historyEntries.length === 0 && (
                        <div className="px-3 py-3 text-xs text-slate-400">No earlier versions in git.</div>
                      )}
                      {historyEntries?.map((entry) => {
                        const slot = slotA.kind === "sha" && slotA.sha === entry.sha
                          ? "A"
                          : slotB.kind === "sha" && slotB.sha === entry.sha
                            ? "B"
                            : null;
                        return (
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
                            className="w-full text-left px-3 py-2 text-xs border-t border-slate-700/60 hover:bg-slate-700/60 transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider",
                                  entry.opKind === "pull" && "bg-sky-900/60 text-sky-200",
                                  entry.opKind === "push" && "bg-emerald-900/60 text-emerald-200",
                                  entry.opKind === "promote" && "bg-purple-900/60 text-purple-200",
                                  entry.opKind === "manual" && "bg-slate-700 text-slate-200",
                                  entry.opKind === "auto" && "bg-amber-900/60 text-amber-200",
                                  entry.opKind === "merge" && "bg-indigo-900/60 text-indigo-200",
                                  entry.opKind === "other" && "bg-slate-700 text-slate-300",
                                )}
                              >
                                {entry.opKind}
                              </span>
                              <span className="font-mono text-slate-400">{entry.shortSha}</span>
                              <span className="text-slate-500">·</span>
                              <span className="text-slate-400">{new Date(entry.isoDate).toLocaleString()}</span>
                              {slot && <span className="ml-auto text-[10px] font-mono text-amber-300">in {slot}</span>}
                            </div>
                            <div className="mt-0.5 text-slate-300 truncate" title={entry.subject}>
                              {entry.subject.length > 120 ? entry.subject.slice(0, 117) + "…" : entry.subject}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate">{entry.author}</div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {gitAvailable !== false && !compareMode && (
                <div className="relative shrink-0" ref={historyDropdownRef}>
                  <button
                    type="button"
                    onClick={handleOpenHistory}
                    title="View previous versions of this file"
                    className={cn(
                      "px-2 py-0.5 text-[11px] font-medium rounded border transition-colors flex items-center gap-1",
                      viewingSha
                        ? "border-amber-500 bg-amber-700/30 text-amber-200 hover:bg-amber-600/40"
                        : "border-slate-600 bg-slate-700/40 text-slate-200 hover:bg-slate-600/40",
                    )}
                  >
                    {viewingSha ? `@ ${viewingShortSha}` : "Versions"}
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {historyOpen && (
                    <div className="absolute right-0 top-full mt-1 w-[28rem] max-h-96 overflow-y-auto rounded-md border border-slate-600 bg-slate-800 shadow-xl z-30 text-slate-200">
                      <button
                        type="button"
                        onClick={() => {
                          setHistoryOpen(false);
                          if (viewingSha) void handleViewCurrent();
                        }}
                        className={cn(
                          "w-full text-left px-3 py-2 text-xs border-b border-slate-700 hover:bg-slate-700/60",
                          !viewingSha && "bg-sky-900/30",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Working tree (current)</span>
                          {!viewingSha && <span className="text-[10px] text-sky-300">● viewing</span>}
                        </div>
                        <div className="text-[10px] text-slate-400">Live file on disk</div>
                      </button>
                      {historyLoading && (
                        <div className="px-3 py-3 text-xs text-slate-400">Loading history…</div>
                      )}
                      {historyError && (
                        <div className="px-3 py-3 text-xs text-rose-400">{historyError}</div>
                      )}
                      {!historyLoading && !historyError && historyEntries && historyEntries.length === 0 && (
                        <div className="px-3 py-3 text-xs text-slate-400">No earlier versions in git.</div>
                      )}
                      {historyEntries?.map((entry) => {
                        const isActive = viewingSha === entry.sha;
                        return (
                          <button
                            key={entry.sha}
                            type="button"
                            onClick={() => handleVersionSelect(entry)}
                            className={cn(
                              "w-full text-left px-3 py-2 text-xs border-t border-slate-700/60 hover:bg-slate-700/60 transition-colors",
                              isActive && "bg-amber-900/30",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider",
                                  entry.opKind === "pull" && "bg-sky-900/60 text-sky-200",
                                  entry.opKind === "push" && "bg-emerald-900/60 text-emerald-200",
                                  entry.opKind === "promote" && "bg-purple-900/60 text-purple-200",
                                  entry.opKind === "manual" && "bg-slate-700 text-slate-200",
                                  entry.opKind === "auto" && "bg-amber-900/60 text-amber-200",
                                  entry.opKind === "merge" && "bg-indigo-900/60 text-indigo-200",
                                  entry.opKind === "other" && "bg-slate-700 text-slate-300",
                                )}
                              >
                                {entry.opKind}
                              </span>
                              <span className="font-mono text-slate-400">{entry.shortSha}</span>
                              <span className="text-slate-500">·</span>
                              <span className="text-slate-400">
                                {new Date(entry.isoDate).toLocaleString()}
                              </span>
                              {isActive && <span className="ml-auto text-[10px] text-amber-300">● viewing</span>}
                            </div>
                            <div className="mt-0.5 text-slate-300 truncate" title={entry.subject}>
                              {entry.subject.length > 120 ? entry.subject.slice(0, 117) + "…" : entry.subject}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate">{entry.author}</div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {esvMeta && !viewingSha && !compareMode && (
                <button
                  type="button"
                  title={`Find usages of esv-${esvMeta.name}`}
                  onClick={handleFindUsages}
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium rounded border border-sky-600 bg-sky-700/30 text-sky-200 hover:bg-sky-600/40 transition-colors"
                >
                  Find usages
                </button>
              )}
              {!compareMode && (
                <button
                  type="button"
                  title="Copy content"
                  onClick={() => {
                    if (!fileContent) return;
                    navigator.clipboard.writeText(fileContent).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className="shrink-0 p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
                >
                  {copied ? (
                    <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                  )}
                </button>
              )}
              <FullscreenButton fullscreen={fullscreen} onToggle={() => setFullscreen((f) => !f)} dark />
            </div>
            {viewingSha && !compareMode && (
              <div className="px-4 py-1.5 border-b border-amber-700/40 bg-amber-900/30 flex items-center gap-3 text-xs text-amber-100">
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
                  className="ml-auto px-2 py-0.5 text-[11px] font-medium rounded border border-amber-600 bg-amber-800/40 hover:bg-amber-700/50 disabled:opacity-50"
                >
                  Back to current
                </button>
              </div>
            )}
            {usagesOpen && esvMeta && !compareMode && (
              <div className="border-b border-slate-700 bg-slate-800/80 max-h-56 overflow-y-auto">
                <div className="px-4 py-1.5 border-b border-slate-700 bg-slate-800 flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                    Usages of esv-{esvMeta.name}
                  </span>
                  {usages && (
                    <span className="text-[10px] text-slate-400">
                      {usages.length} reference{usages.length === 1 ? "" : "s"}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setUsagesOpen(false)}
                    className="ml-auto text-slate-400 hover:text-slate-200 text-xs"
                    title="Close usages"
                  >
                    ✕
                  </button>
                </div>
                {usagesLoading ? (
                  <div className="px-4 py-3 text-xs text-slate-400">Scanning…</div>
                ) : usagesError ? (
                  <div className="px-4 py-3 text-xs text-rose-400">{usagesError}</div>
                ) : usages && usages.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-slate-400">Not referenced anywhere.</div>
                ) : (
                  <div className="divide-y divide-slate-700/60">
                    {usages?.map((ref, i) => {
                      const isActive = selectedFile === ref.path && highlightLine === ref.line;
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => openReference(ref)}
                          className={cn(
                            "w-full flex items-start gap-2 px-4 py-1.5 text-left text-[11px] font-mono transition-colors",
                            isActive ? "bg-sky-900/50" : "hover:bg-slate-700/40"
                          )}
                        >
                          <span className="shrink-0 text-slate-500 tabular-nums w-8 text-right">{ref.line}</span>
                          <span className="shrink-0 text-sky-300 truncate max-w-[320px]" title={ref.path}>{ref.path}</span>
                          <span className="flex-1 text-slate-400 break-all">{ref.snippet}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="flex-1 overflow-auto">
              {compareMode ? (
                <>
                  {slotLoading && (
                    <div className="flex items-center justify-center h-full text-sm text-slate-500">
                      Loading diff…
                    </div>
                  )}
                  {!slotLoading && (slotAError || slotBError) && (
                    <div className="p-4 text-xs">
                      {slotAError && (
                        <div className="text-rose-400">A failed: {slotAError}</div>
                      )}
                      {slotBError && (
                        <div className="text-rose-400">B failed: {slotBError}</div>
                      )}
                    </div>
                  )}
                  {!slotLoading && !slotAError && !slotBError && slotAContent !== null && slotBContent !== null && (
                    <FileDiffViewer
                      aContent={slotAContent}
                      bContent={slotBContent}
                      aLabel={slotLabel(slotA)}
                      bLabel={slotLabel(slotB)}
                      fileName={selectedFileName ?? selectedFile ?? ""}
                    />
                  )}
                </>
              ) : (
                <>
                  {fileLoading && <div className="flex items-center justify-center h-full text-sm text-slate-500">Loading…</div>}
                  {!fileLoading && fileContent !== null && <FileContent content={fileContent} fileName={selectedFileName ?? ""} highlightLine={highlightLine} />}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
            {tree.length > 0 ? "Select a file to view its contents" : "No files to display"}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Managed-object hit navigation map ─────────────────────────────────────────

type HitNavRule =
  | { scope: string; matchBy: "id"; extract: (filePath: string) => string | null }
  | { scope: string; matchBy: "label"; extract: (filePath: string) => string | null };

const HIT_NAVIGATION: Record<string, HitNavRule> = {
  "journey": { scope: "journeys", matchBy: "id", extract: (fp) => fp.match(/journeys\/([^/]+)\//)?.[1] ?? null },
  "custom-endpoint": { scope: "endpoints", matchBy: "id", extract: (fp) => fp.match(/^endpoints\/([^/]+)\//)?.[1] ?? null },
  "workflow": { scope: "iga-workflows", matchBy: "id", extract: (fp) => fp.match(/^iga\/workflows\/([^/]+)\//)?.[1] ?? null },
  "managed-object-config": { scope: "managed-objects", matchBy: "id", extract: (fp) => fp.match(/managed-objects\/([^/]+)\//)?.[1] ?? null },
  "sync-mapping": { scope: "connector-mappings", matchBy: "id", extract: (fp) => fp.match(/^sync\/mappings\/([^/]+)\//)?.[1] ?? null },
  "scheduler": { scope: "schedules", matchBy: "id", extract: (fp) => fp.match(/^schedules\/([^/]+)\//)?.[1] ?? null },
  "internal-role": { scope: "internal-roles", matchBy: "id", extract: (fp) => fp.match(/^internal-roles\/([^/.]+)/)?.[1] ?? null },
  "iga-assignment": { scope: "iga-assignments", matchBy: "id", extract: (fp) => fp.match(/^iga\/assignments\/([^/.]+)/)?.[1] ?? null },
  "iga-form": { scope: "iga-forms", matchBy: "id", extract: (fp) => fp.match(/^iga\/forms\/([^/.]+)/)?.[1] ?? null },

  // Scripts: scripts-config files have id = "<uuid>.json", which IS the basename.
  "script-library-config": { scope: "scripts", matchBy: "id", extract: (fp) => fp.match(/scripts-config\/([^/]+)$/)?.[1] ?? null },
  // Scripts: content files use the script's `name` field (the audit item's label) as the JS filename without extension.
  "script-library": { scope: "scripts", matchBy: "label", extract: (fp) => fp.match(/scripts-content\/[^/]+\/(.+)\.js$/)?.[1] ?? null },
};

// ── Sections view ─────────────────────────────────────────────────────────────

interface AuditEntry {
  scope: string;
  fileCount: number;
  exists: boolean;
  items: AuditItem[];
  selectable: boolean;
}

const ALL_SCOPES = CONFIG_SCOPES.map((s) => s.value);

const GROUPS = Array.from(new Set(CONFIG_SCOPES.map((s) => s.group)));

function SectionsView({
  environment,
  preselect,
  onPreselectApplied,
}: {
  environment: string;
  preselect?: { scope: string; item: string; fileName?: string; line?: number; query?: string } | null;
  onPreselectApplied?: () => void;
}) {
  const [auditData, setAuditData] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<AuditItem | null>(null);
  const [files, setFiles] = useState<ViewableFile[] | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [fileLoading, setFileLoading] = useState(false);
  const [itemFilter, setItemFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [wrapScripts, setWrapScripts] = useState(true);
  const [copied, setCopied] = useState(false);
  const [esvMode, setEsvMode] = useEsvDisplayMode();
  const [col1Width, setCol1Width] = useState(192);
  const [col2Width, setCol2Width] = useState(224);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageData, setUsageData] = useState<{ journey: string; nodeName: string; nodeType: string; nodeUuid: string }[] | null>(null);
  const [usageScripts, setUsageScripts] = useState<{ scriptName: string; scriptUuid: string; scriptType: string }[] | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [journeyUsageData, setJourneyUsageData] = useState<{ journey: string; nodeName: string; nodeType: string; nodeUuid: string }[] | null>(null);
  const [endpointUsageData, setEndpointUsageData] = useState<EndpointUsageRef[] | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(undefined);
  const pendingFocusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleColumnDrag = useCallback((setter: (v: number) => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = setter === setCol1Width ? col1Width : col2Width;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setter(Math.max(120, Math.min(500, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [col1Width, col2Width]);

  // Fetch audit for all scopes when env changes
  useEffect(() => {
    if (!environment) return;
    setAuditLoading(true);
    setSelectedScope(null);
    setSelectedItem(null);
    setFiles(null);
    const params = new URLSearchParams({ environment, scopes: ALL_SCOPES.join(",") });
    fetch(`/api/push/audit?${params}`)
      .then((r) => r.json())
      .then((data: AuditEntry[]) => setAuditData(data))
      .finally(() => setAuditLoading(false));
  }, [environment]);

  // Refresh the audit (scope item listings) without tearing down
  // selection state. Used on window focus / tab visibility change so
  // changes from pulls (here or in another tab) appear without a full
  // page reload. The per-component file tree has its own re-fetch logic.
  const refreshListings = useCallback(() => {
    if (!environment) return;
    const params = new URLSearchParams({ environment, scopes: ALL_SCOPES.join(",") });
    fetch(`/api/push/audit?${params}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: AuditEntry[] | null) => { if (data) setAuditData(data); })
      .catch(() => { });
  }, [environment]);

  useEffect(() => {
    if (!environment) return;
    const onFocus = () => refreshListings();
    const onVisibility = () => { if (document.visibilityState === "visible") refreshListings(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [environment, refreshListings]);

  // Reset usage panel when item changes
  useEffect(() => { setUsageOpen(false); setUsageData(null); setUsageScripts(null); setEndpointUsageData(null); setJourneyUsageData(null); }, [selectedItem]);

  // Track the file name + line to highlight after files load (deep-link flow).
  const pendingFileSelection = useRef<{ fileName?: string; line?: number; query?: string } | null>(null);
  const [highlightLine, setHighlightLine] = useState<number | undefined>(undefined);
  const [highlightQuery, setHighlightQuery] = useState<string | undefined>(undefined);
  // Ref to the currently-selected item button in the middle column so we can
  // scroll it into view whenever selection changes (e.g. via deep-link or
  // outline click). block:"nearest" keeps the panel still when the row is
  // already visible.
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!selectedItem) return;
    const el = selectedItemRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedItem]);

  // Apply an incoming "Find in Browse" deep link once audit data is loaded.
  // Matches scope exactly; for the item we try exact id match, then
  // case-insensitive prefix, then basename-stripped (.json) to absorb the
  // script UUID vs filename mismatch from different callers.
  useEffect(() => {
    if (!preselect || auditLoading || auditData.length === 0) return;
    const entry = auditData.find((e) => e.scope === preselect.scope);
    if (!entry) { onPreselectApplied?.(); return; }
    setSelectedScope(preselect.scope);
    if (preselect.item) {
      const needle = preselect.item.toLowerCase();
      const stripped = needle.replace(/\.json$/, "");
      const match =
        entry.items.find((i) => i.id === preselect.item) ??
        entry.items.find((i) => i.id.toLowerCase() === needle) ??
        entry.items.find((i) => i.id.toLowerCase().replace(/\.json$/, "") === stripped) ??
        entry.items.find((i) => i.label.toLowerCase() === needle);
      if (match) {
        setSelectedItem(match);
        // Remember the target file + line so we can activate the right tab
        // once /api/push/item returns the list of viewable files.
        if (preselect.fileName || preselect.line || preselect.query) {
          pendingFileSelection.current = { fileName: preselect.fileName, line: preselect.line, query: preselect.query };
        }
      }
    }
    onPreselectApplied?.();
  }, [preselect, auditData, auditLoading, onPreselectApplied]);

  // Clear highlight when the user navigates to a different item.
  useEffect(() => { setHighlightLine(undefined); setHighlightQuery(undefined); }, [selectedItem]);

  const fetchUsage = useCallback(() => {
    if (!selectedItem || selectedScope !== "scripts") return;
    setUsageOpen(true);
    setUsageLoading(true);
    fetch(`/api/analyze/script-usage?env=${encodeURIComponent(environment)}&scriptId=${encodeURIComponent(selectedItem.id.replace(".json", ""))}`)
      .then((r) => r.json())
      .then((data) => { setUsageData(data.usedBy ?? []); setUsageScripts(data.usedByScripts ?? []); })
      .catch(() => { setUsageData([]); setUsageScripts([]); })
      .finally(() => setUsageLoading(false));
  }, [environment, selectedScope, selectedItem]);

  const fetchJourneyUsage = useCallback(() => {
    if (!selectedItem || selectedScope !== "journeys") return;
    setUsageOpen(true);
    setUsageLoading(true);
    fetch(`/api/analyze/journey-usage?env=${encodeURIComponent(environment)}&journeyName=${encodeURIComponent(selectedItem.id)}`)
      .then((r) => r.json())
      .then((data) => setJourneyUsageData(data.usedBy ?? []))
      .catch(() => setJourneyUsageData([]))
      .finally(() => setUsageLoading(false));
  }, [environment, selectedScope, selectedItem]);

  const fetchEndpointUsage = useCallback(() => {
    if (!selectedItem || selectedScope !== "endpoints") return;
    setUsageOpen(true);
    setUsageLoading(true);
    fetch(`/api/analyze/endpoint-usage?env=${encodeURIComponent(environment)}&endpointName=${encodeURIComponent(selectedItem.id)}`)
      .then((r) => r.json())
      .then((data) => setEndpointUsageData(data.usedBy ?? []))
      .catch(() => setEndpointUsageData([]))
      .finally(() => setUsageLoading(false));
  }, [environment, selectedScope, selectedItem]);

  const onOpenHit = useCallback((hit: ManagedObjectHit) => {
    const nav = HIT_NAVIGATION[hit.category];
    if (!nav) return;
    const key = nav.extract(hit.filePath);
    if (!key) return;
    const entry = auditData.find((e) => e.scope === nav.scope);
    if (!entry) return;
    const item = nav.matchBy === "id"
      ? entry.items.find((it) => it.id === key)
      : entry.items.find((it) => it.label === key);
    if (!item) return;
    setSelectedScope(nav.scope);
    setSelectedItem(item);
    setUsageOpen(false);
  }, [auditData]);

  const canOpenHit = useCallback((hit: ManagedObjectHit) => {
    const nav = HIT_NAVIGATION[hit.category];
    if (!nav) return false;
    return nav.extract(hit.filePath) !== null;
  }, []);

  // Fetch file content when item is selected
  useEffect(() => {
    if (!selectedScope || !selectedItem) { setFiles(null); return; }
    setFileLoading(true);
    setFiles(null);
    setActiveTab(0);
    setFocusNodeId(undefined);

    const params = new URLSearchParams({ environment, scope: selectedScope, item: selectedItem.id });
    fetch(`/api/push/item?${params}`)
      .then((r) => r.json())
      .then((data: { files: ViewableFile[] }) => {
        const loaded = data.files ?? [];
        setFiles(loaded);
        // Apply pending focus after file loads (graph needs time to render)
        if (pendingFocusRef.current) {
          const nodeId = pendingFocusRef.current;
          pendingFocusRef.current = undefined;
          setTimeout(() => setFocusNodeId(nodeId), 800);
        }
        // Apply a pending file-tab + line selection from a "Find in Browse"
        // deep link. Match the target file by basename, then set the active
        // tab and highlight line.
        const pending = pendingFileSelection.current;
        if (pending && loaded.length > 0) {
          pendingFileSelection.current = null;
          if (pending.fileName) {
            const idx = loaded.findIndex((f) => f.name === pending.fileName);
            if (idx >= 0) setActiveTab(idx);
          }
          if (pending.line) setHighlightLine(pending.line);
          if (pending.query) setHighlightQuery(pending.query);
        }
      })
      .catch(() => setFiles([]))
      .finally(() => setFileLoading(false));
  }, [environment, selectedScope, selectedItem]);

  const handleSelectScope = (scope: string) => {
    setSelectedScope(scope);
    setSelectedItem(null);
    setFiles(null);
    setItemFilter("");
  };

  // Resolve a ScriptFileViewer reference click (ESV / library / endpoint) to
  // an audit item and switch the Browse view to it.
  const handleNavigateTarget = useCallback((target: NavigateTarget) => {
    const pickItem = (scope: string, match: (id: string, label: string) => boolean) => {
      const entry = auditData.find((e) => e.scope === scope);
      if (!entry) return;
      const found = entry.items.find((it) => match(it.id, it.label));
      if (!found) return;
      setSelectedScope(scope);
      setSelectedItem(found);
      setItemFilter("");
    };
    if (target.scope === "variables" || target.scope === "secrets") {
      const needle = target.esvName.toLowerCase();
      // Try variables first, then secrets — caller defaults to variables but
      // many auth scripts reach for secret ESVs via the same form.
      const tryScopes = target.scope === "secrets" ? ["secrets", "variables"] : ["variables", "secrets"];
      for (const scope of tryScopes) {
        const entry = auditData.find((e) => e.scope === scope);
        const found = entry?.items.find((it) => {
          const id = it.id.toLowerCase();
          return id === `esv-${needle}.json` || id === `esv-${needle}.variable.json` || id === `esv-${needle}.secret.json` || id.includes(needle);
        });
        if (found && entry) {
          setSelectedScope(scope);
          setSelectedItem(found);
          setItemFilter("");
          return;
        }
      }
    } else if (target.scope === "scripts") {
      const needle = target.scriptName.toLowerCase();
      pickItem("scripts", (_, label) => label.toLowerCase() === needle);
    } else if (target.scope === "scripts-by-id") {
      pickItem("scripts", (id) => id === target.scriptId || id === `${target.scriptId}.json`);
    } else if (target.scope === "endpoints") {
      const needle = target.endpointName.toLowerCase();
      pickItem("endpoints", (id) => id.toLowerCase() === needle || id.toLowerCase() === `${needle}.json` || id.toLowerCase().startsWith(`${needle}.`));
    }
  }, [auditData]);

  const scopeEntry = auditData.find((e) => e.scope === selectedScope);
  const filterLower = itemFilter.trim().toLowerCase();
  const filteredItems = scopeEntry
    ? filterLower
      ? scopeEntry.items.filter((i) =>
        i.label.toLowerCase().includes(filterLower) ||
        (i.value !== undefined && i.value.toLowerCase().includes(filterLower))
      )
      : scopeEntry.items
    : [];

  const activeFile = files?.[activeTab];

  // ── Versions / Compare for non-workflow scopes ─────────────────────────
  // SectionsView is the default Browse view; we wire the same Versions
  // dropdown + Compare mode that TreeView has. Journeys reuse the Versions
  // picker so users can view the journey graph at any historical commit
  // (iga-workflows still rely on ItemComparePanel because they're
  // multi-file with no single primary file to swap).
  const showVersionUi = selectedScope !== "iga-workflows";
  const versionUi = useVersionPicker({
    environment,
    filePath: activeFile?.relPath ?? null,
    fileName: activeFile?.name ?? "",
    workingContent: activeFile?.content ?? null,
    theme: selectedScope === "journeys" ? "light" : "dark",
    renderBody: (mode) => {
      if (!activeFile) return null;
      if (mode.kind === "compare") {
        return (
          <DefaultCompareBody
            aContent={mode.aContent}
            bContent={mode.bContent}
            aLabel={mode.aLabel}
            bLabel={mode.bLabel}
            fileName={activeFile.name}
            loading={mode.loading}
            error={mode.error}
          />
        );
      }
      if (mode.loading) {
        return <div className="flex items-center justify-center h-full text-sm text-slate-500">Loading version…</div>;
      }
      const content = mode.content ?? "";
      // Journey scope: render the journey graph from the picked content.
      // Node-detail fetches still target the working tree, so the graph
      // shape (nodes + connections) reflects the chosen sha while inner
      // details (scripts, inner journeys) mirror current state.
      if (selectedScope === "journeys") {
        return (
          <div className="h-full">
            <JourneyGraph
              key={`${selectedItem?.id ?? ""}:${mode.viewingSha ?? "current"}`}
              json={content}
              fitViewKey={fullscreen ? 1 : 0}
              environment={environment}
              journeyId={selectedItem?.id}
              focusNodeId={mode.viewingSha ? undefined : focusNodeId}
            />
          </div>
        );
      }
      const lower = activeFile.name.toLowerCase();
      const isJson = lower.endsWith(".json");
      const isScript = lower.endsWith(".js") || lower.endsWith(".groovy");
      const lineHighlight = mode.viewingSha ? undefined : highlightLine;
      const queryHighlight = mode.viewingSha ? undefined : highlightQuery;
      if (isJson) {
        return (
          <div className="h-full min-h-0 overflow-hidden">
            <JsonFileViewer
              key={`${selectedItem?.id ?? ""}:${activeFile.name}:${isEsvScope(selectedScope) ? esvMode : ""}:${mode.viewingSha ?? "current"}`}
              content={isEsvScope(selectedScope) ? applyEsvDecoding(content, esvMode) : content}
              fileName={activeFile.name}
              highlightLine={lineHighlight}
            />
          </div>
        );
      }
      if (isScript) {
        return (
          <div className="h-full min-h-0 overflow-hidden">
            <ScriptFileViewer
              key={`${selectedItem?.id ?? ""}:${activeFile.name}:${mode.viewingSha ?? "current"}`}
              content={content}
              fileName={activeFile.name}
              environment={environment}
              relPath={activeFile.relPath}
              highlightLine={lineHighlight}
              highlightQuery={queryHighlight}
              onNavigate={handleNavigateTarget}
            />
          </div>
        );
      }
      return (
        <div className="overflow-auto h-full">
          <FileContent
            content={content}
            fileName={activeFile.name}
            highlightLine={lineHighlight}
            wrap={(selectedScope === "scripts" || selectedScope === "endpoints") && wrapScripts}
          />
        </div>
      );
    },
  });

  return (
    <div className="flex flex-1 min-h-0 rounded-lg border border-slate-200 overflow-hidden">

      {/* Column 1 — Scopes */}
      <div className="shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col overflow-hidden" style={{ width: col1Width }}>
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-200 bg-white shrink-0">
          <svg className="w-3 h-3 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            placeholder="Filter scopes / items…"
            className="flex-1 text-[11px] bg-transparent text-slate-700 placeholder-slate-400 outline-none min-w-0"
          />
          {scopeFilter && (
            <button type="button" onClick={() => setScopeFilter("")} className="text-slate-400 hover:text-slate-600 shrink-0">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {auditLoading ? (
            <div className="p-3 space-y-2">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="h-6 bg-slate-200 rounded animate-pulse" />
              ))}
            </div>
          ) : (() => {
            const q = scopeFilter.trim().toLowerCase();
            return GROUPS.map((group) => {
              const groupScopes = CONFIG_SCOPES.filter((s) => {
                if (s.group !== group) return false;
                if (!q) return true;
                if (s.label.toLowerCase().includes(q)) return true;
                if (s.value.toLowerCase().includes(q)) return true;
                const entry = auditData.find((e) => e.scope === s.value);
                return entry?.items.some((i) =>
                  i.label.toLowerCase().includes(q) ||
                  (i.value !== undefined && i.value.toLowerCase().includes(q))
                ) ?? false;
              });
              if (groupScopes.length === 0) return null;
              return (
                <div key={group}>
                  <p className="px-3 pt-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{group}</p>
                  {groupScopes.map((s) => {
                    const isUnsupported = s.cliSupported === false;
                    const entry = auditData.find((e) => e.scope === s.value);
                    const count = entry?.items.length ?? 0;
                    const hasFiles = (entry?.fileCount ?? 0) > 0;
                    return (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => handleSelectScope(s.value)}
                        className={cn(
                          "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors border-l-2",
                          selectedScope === s.value
                            ? "border-sky-500 bg-sky-50 text-sky-700 font-medium"
                            : "border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-800",
                          isUnsupported ? "opacity-50" : !hasFiles && "opacity-40"
                        )}
                      >
                        <span className="truncate flex-1">{s.label}</span>
                        {isUnsupported ? (
                          <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-600 border border-amber-200 leading-none shrink-0">
                            No CLI
                          </span>
                        ) : entry && (
                          <span className="text-[10px] tabular-nums text-slate-400 shrink-0">
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* Drag handle 1 */}
      <div
        onMouseDown={handleColumnDrag(setCol1Width)}
        className="w-1 shrink-0 bg-slate-200 hover:bg-sky-400 cursor-col-resize transition-colors"
      />

      {/* Column 2 — Items */}
      <div className="shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-hidden" style={{ width: col2Width }}>
        {selectedScope ? (
          <>
            {/* Header */}
            <div className="px-3 py-2 border-b border-slate-100 shrink-0">
              <p className="text-xs font-medium text-slate-700 truncate">
                {CONFIG_SCOPES.find((s) => s.value === selectedScope)?.label ?? selectedScope}
              </p>
              {scopeEntry && (
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {scopeEntry.items.length} item{scopeEntry.items.length !== 1 ? "s" : ""}
                  {scopeEntry.items.length !== scopeEntry.fileCount && (
                    <span className="ml-1">· {scopeEntry.fileCount} file{scopeEntry.fileCount !== 1 ? "s" : ""}</span>
                  )}
                </p>
              )}
            </div>

            {/* Filter */}
            {(scopeEntry?.items.length ?? 0) > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 shrink-0">
                <svg className="w-3 h-3 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                </svg>
                <input
                  type="text"
                  value={itemFilter}
                  onChange={(e) => setItemFilter(e.target.value)}
                  placeholder="Filter…"
                  className="flex-1 text-[11px] bg-transparent text-slate-700 placeholder-slate-400 outline-none min-w-0"
                />
                {itemFilter && (
                  <button type="button" onClick={() => setItemFilter("")} className="text-slate-400 hover:text-slate-600 shrink-0">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            {/* Item list */}
            <div className="flex-1 overflow-y-auto">
              {filteredItems.length === 0 && (
                <p className="text-[11px] text-slate-400 text-center py-6">
                  {itemFilter ? "No matches" : "No items"}
                </p>
              )}
              {filteredItems.map((item) => {
                const isSelected = selectedItem?.id === item.id;
                return (
                  <button
                    key={item.id}
                    ref={isSelected ? selectedItemRef : undefined}
                    type="button"
                    onClick={() => setSelectedItem(item)}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs transition-colors truncate border-l-2",
                      isSelected
                        ? "border-sky-500 bg-sky-50 text-sky-700 font-medium"
                        : "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-800"
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-400 p-4 text-center">
            {selectedScope && CONFIG_SCOPES.find((s) => s.value === selectedScope)?.cliSupported === false
              ? "Not managed by fr-config-manager"
              : "Select a scope to browse its items"}
          </div>
        )}
      </div>

      {/* Drag handle 2 */}
      <div
        onMouseDown={handleColumnDrag(setCol2Width)}
        className="w-1 shrink-0 bg-slate-200 hover:bg-sky-400 cursor-col-resize transition-colors"
      />

      {/* Column 3 — File content / Journey graph */}
      <div className={cn(
        "flex flex-col overflow-hidden min-w-0",
        fullscreen ? "fixed inset-0 z-50" : "flex-1",
        selectedItem && (selectedScope === "journeys" || selectedScope === "iga-workflows") ? "bg-slate-50" : "bg-slate-900"
      )}>
        {selectedItem ? (
          <>
            {/* Header bar */}
            <div className={cn(
              "flex items-center gap-2 px-4 py-2 border-b shrink-0",
              (selectedScope === "journeys" || selectedScope === "iga-workflows")
                ? "border-slate-200 bg-white"
                : "border-slate-700 bg-slate-800"
            )}>
              <span className={cn(
                "truncate flex-1",
                selectedScope === "journeys"
                  ? "text-sm font-bold text-slate-800"
                  : "text-xs font-medium text-slate-300"
              )}>
                {selectedItem.label}
              </span>

              {/* File tabs — non-journey/workflow multi-file items */}
              {selectedScope !== "journeys" && selectedScope !== "iga-workflows" && files && files.length > 1 && (
                <div className="flex gap-0 overflow-x-auto">
                  {files.map((f, i) => (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => { setActiveTab(i); setHighlightLine(undefined); }}
                      className={cn(
                        "px-3 py-1 text-[10px] shrink-0 border-b-2 transition-colors",
                        i === activeTab
                          ? "border-sky-500 text-sky-400"
                          : "border-transparent text-slate-500 hover:text-slate-300"
                      )}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
              )}

              {activeFile && (
                <button
                  type="button"
                  title="Copy content"
                  onClick={() => {
                    navigator.clipboard.writeText(activeFile.content).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className={cn(
                    "shrink-0 p-1 rounded transition-colors",
                    (selectedScope === "journeys" || selectedScope === "iga-workflows")
                      ? "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                  )}
                >
                  {copied ? (
                    <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.184" />
                    </svg>
                  )}
                </button>
              )}
              {/* Versions dropdown + Compare button (non-journey/workflow scopes only) */}
              {showVersionUi && activeFile && versionUi.headerControls}
              {/* Item-level compare for multi-file items (journey, IGA workflow) */}
              {(selectedScope === "journeys" || selectedScope === "iga-workflows") && selectedItem && (
                <ItemComparePanel
                  environment={environment}
                  scope={selectedScope}
                  item={selectedItem.id}
                  itemLabel={selectedItem.label}
                />
              )}
              {selectedScope === "scripts" && (
                <button
                  type="button"
                  onClick={fetchUsage}
                  className={cn(
                    "shrink-0 px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                    usageOpen
                      ? "bg-violet-100 text-violet-700"
                      : "text-slate-400 hover:text-violet-600 hover:bg-violet-50"
                  )}
                >
                  Find Usage
                </button>
              )}
              {selectedScope === "journeys" && (
                <button
                  type="button"
                  onClick={fetchJourneyUsage}
                  className={cn(
                    "shrink-0 px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                    usageOpen
                      ? "bg-violet-100 text-violet-700"
                      : "text-slate-400 hover:text-violet-600 hover:bg-violet-50"
                  )}
                >
                  Find Usage
                </button>
              )}
              {selectedScope === "endpoints" && (
                <button
                  type="button"
                  onClick={fetchEndpointUsage}
                  className={cn(
                    "shrink-0 px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                    usageOpen
                      ? "bg-violet-100 text-violet-700"
                      : "text-slate-400 hover:text-violet-600 hover:bg-violet-50"
                  )}
                >
                  Find Usage
                </button>
              )}
              {selectedScope === "managed-objects" && selectedItem && (
                <button
                  type="button"
                  onClick={() => setUsageOpen((v) => !v)}
                  className={cn(
                    "shrink-0 px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                    usageOpen
                      ? "bg-violet-100 text-violet-700"
                      : "text-slate-400 hover:text-violet-600 hover:bg-violet-50"
                  )}
                >
                  Find Usage
                </button>
              )}
              {(selectedScope === "scripts" || selectedScope === "endpoints") && (
                <WrapButton wrap={wrapScripts} onToggle={() => setWrapScripts((w) => !w)} />
              )}
              {isEsvScope(selectedScope) && (
                <EsvDisplayToggle mode={esvMode} onChange={setEsvMode} />
              )}
              <FullscreenButton
                fullscreen={fullscreen}
                onToggle={() => setFullscreen((f) => !f)}
                dark={selectedScope !== "journeys" && selectedScope !== "iga-workflows"}
              />
            </div>

            {/* Script usage panel */}
            {usageOpen && selectedScope === "scripts" && (
              <div className="px-4 py-2.5 border-b border-slate-700 bg-slate-800 shrink-0 max-h-48 overflow-y-auto">
                {usageLoading ? (
                  <p className="text-xs text-slate-400">Searching…</p>
                ) : (!usageData || usageData.length === 0) && (!usageScripts || usageScripts.length === 0) ? (
                  <p className="text-xs text-slate-400 italic">Not used in any journey or script.</p>
                ) : (
                  <div className="space-y-2">
                    {usageData && usageData.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">
                          Used in {usageData.length} journey {usageData.length === 1 ? "node" : "nodes"}
                        </p>
                        {usageData.map((ref, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
                            <button
                              type="button"
                              onClick={() => {
                                // Navigate to the journey and focus on the script node
                                const journeyItem = auditData
                                  .find((e) => e.scope === "journeys")
                                  ?.items.find((item: { id: string }) => item.id === ref.journey);
                                if (journeyItem) {
                                  pendingFocusRef.current = ref.nodeUuid;
                                  setSelectedScope("journeys");
                                  setSelectedItem(journeyItem);
                                  setUsageOpen(false);
                                }
                              }}
                              className="text-sky-400 hover:text-sky-300 hover:underline font-medium"
                            >
                              {ref.journey}
                            </button>
                            <span className="text-slate-500">→</span>
                            <span className="text-slate-400">{ref.nodeName}</span>
                            <span className="text-[10px] text-slate-500 font-mono">{ref.nodeType}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {usageScripts && usageScripts.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">
                          Imported by {usageScripts.length} {usageScripts.length === 1 ? "script" : "scripts"}
                        </p>
                        {usageScripts.map((ref, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                            <button
                              type="button"
                              onClick={() => {
                                const scriptsEntry = auditData.find((e) => e.scope === "scripts");
                                const target = scriptsEntry?.items.find((item) => {
                                  if (ref.scriptUuid && (item.id === `${ref.scriptUuid}.json` || item.id === ref.scriptUuid)) return true;
                                  return item.label === ref.scriptName;
                                });
                                if (target) {
                                  setSelectedItem(target);
                                  setUsageOpen(false);
                                }
                              }}
                              className="text-emerald-400 hover:text-emerald-300 hover:underline font-medium text-left"
                            >
                              {ref.scriptName}
                            </button>
                            <span className="text-[10px] text-slate-500 font-mono">{ref.scriptType}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Journey usage panel */}
            {usageOpen && selectedScope === "journeys" && (
              <div className="px-4 py-2.5 border-b border-slate-200 bg-violet-50 shrink-0 max-h-48 overflow-y-auto">
                {usageLoading ? (
                  <p className="text-xs text-slate-500">Searching…</p>
                ) : !journeyUsageData || journeyUsageData.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">Not used as an inner journey.</p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[10px] text-violet-700 font-semibold uppercase tracking-wide">
                      Used in {journeyUsageData.length} {journeyUsageData.length === 1 ? "journey" : "journeys"}
                    </p>
                    {journeyUsageData.map((ref, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            const journeyItem = auditData
                              .find((e) => e.scope === "journeys")
                              ?.items.find((item: { id: string }) => item.id === ref.journey);
                            if (journeyItem) {
                              pendingFocusRef.current = ref.nodeUuid;
                              setSelectedScope("journeys");
                              setSelectedItem(journeyItem);
                              setUsageOpen(false);
                            }
                          }}
                          className="text-violet-700 hover:text-violet-900 hover:underline font-medium"
                        >
                          {ref.journey}
                        </button>
                        <span className="text-slate-400">→</span>
                        <span className="text-slate-600">{ref.nodeName}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Endpoint usage panel */}
            {usageOpen && selectedScope === "endpoints" && (
              <div className="px-4 py-2.5 border-b border-slate-700 bg-slate-800 shrink-0 max-h-56 overflow-y-auto">
                {usageLoading ? (
                  <p className="text-xs text-slate-400">Searching…</p>
                ) : !endpointUsageData || endpointUsageData.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">Not used in any script, workflow, or endpoint.</p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">
                      Used in {endpointUsageData.length} {endpointUsageData.length === 1 ? "place" : "places"}
                    </p>
                    {endpointUsageData.map((ref, i) => {
                      if (ref.type === "script") {
                        const scriptItem = auditData
                          .find((e) => e.scope === "scripts")
                          ?.items.find((item) => item.id === `${ref.scriptId}.json`);
                        return (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
                            <span className="text-[10px] text-slate-500 shrink-0">Script</span>
                            <button
                              type="button"
                              onClick={() => {
                                if (scriptItem) {
                                  setSelectedScope("scripts");
                                  setSelectedItem(scriptItem);
                                  setUsageOpen(false);
                                }
                              }}
                              className={cn(
                                "font-medium truncate",
                                scriptItem
                                  ? "text-sky-400 hover:text-sky-300 hover:underline"
                                  : "text-slate-500 cursor-default"
                              )}
                            >
                              {ref.scriptName ?? ref.scriptId}
                            </button>
                          </div>
                        );
                      }
                      if (ref.type === "workflow") {
                        const workflowItem = auditData
                          .find((e) => e.scope === "iga-workflows")
                          ?.items.find((item) => item.id === ref.workflowId);
                        return (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                            <span className="text-[10px] text-slate-500 shrink-0">Workflow</span>
                            <button
                              type="button"
                              onClick={() => {
                                if (workflowItem) {
                                  setSelectedScope("iga-workflows");
                                  setSelectedItem(workflowItem);
                                  setUsageOpen(false);
                                }
                              }}
                              className={cn(
                                "font-medium truncate",
                                workflowItem
                                  ? "text-sky-400 hover:text-sky-300 hover:underline"
                                  : "text-slate-500 cursor-default"
                              )}
                            >
                              {ref.workflowId}
                            </button>
                            {ref.stepFile && (
                              <span className="text-[10px] text-slate-500 font-mono truncate">({ref.stepFile})</span>
                            )}
                          </div>
                        );
                      }
                      if (ref.type === "endpoint") {
                        const endpointItem = auditData
                          .find((e) => e.scope === "endpoints")
                          ?.items.find((item) => item.id === ref.endpointId);
                        return (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
                            <span className="text-[10px] text-slate-500 shrink-0">Endpoint</span>
                            <button
                              type="button"
                              onClick={() => {
                                if (endpointItem) {
                                  setSelectedScope("endpoints");
                                  setSelectedItem(endpointItem);
                                  setUsageOpen(false);
                                }
                              }}
                              className={cn(
                                "font-medium truncate",
                                endpointItem
                                  ? "text-sky-400 hover:text-sky-300 hover:underline"
                                  : "text-slate-500 cursor-default"
                              )}
                            >
                              {ref.endpointId}
                            </button>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Managed-object usage panel */}
            {usageOpen && selectedScope === "managed-objects" && selectedItem && environment && (
              <div className="px-4 py-2.5 border-b border-slate-700 bg-slate-800 shrink-0 max-h-72 overflow-y-auto">
                <ManagedObjectUsagePanel
                  key={selectedItem.id}
                  env={environment}
                  type={selectedItem.id.replace(/\.json$/, "")}
                  onClose={() => setUsageOpen(false)}
                  onOpenHit={onOpenHit}
                  canOpenHit={canOpenHit}
                />
              </div>
            )}

            {/* Content */}
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              {fileLoading && (
                <div className={cn("flex items-center justify-center h-full text-sm", selectedScope === "journeys" ? "text-slate-400" : "text-slate-500")}>
                  Loading…
                </div>
              )}
              {!fileLoading && files && files.length === 0 && (
                <div className="flex items-center justify-center h-full text-sm text-slate-500">
                  No files found for this item
                </div>
              )}
              {!fileLoading && activeFile && selectedScope === "journeys" && (
                <>
                  {versionUi.banner}
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {versionUi.bodyNode}
                  </div>
                </>
              )}
              {!fileLoading && files && files.length > 0 && selectedScope === "iga-workflows" && (
                <div className="h-full">
                  <WorkflowGraph files={files} workflowId={selectedItem?.id} />
                </div>
              )}
              {!fileLoading && activeFile && selectedScope !== "journeys" && selectedScope !== "iga-workflows" && (
                <>
                  {versionUi.banner}
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {versionUi.bodyNode}
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-slate-500 p-6 text-center">
            {selectedScope && CONFIG_SCOPES.find((s) => s.value === selectedScope)?.cliSupported === false ? (
              <>
                <span className="text-[11px] font-semibold px-2 py-1 rounded bg-amber-100 text-amber-700 border border-amber-200">
                  Not supported by fr-config-manager
                </span>
                <span className="text-xs text-slate-400">
                  {CONFIG_SCOPES.find((s) => s.value === selectedScope)?.description}
                </span>
              </>
            ) : selectedScope ? (
              "Select an item to view its contents"
            ) : (
              "Select a scope and item"
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const ENV_STORAGE_KEY = "aic:configs:env";

export function ConfigsViewer({ environments }: { environments: Environment[] }) {
  // Start with the first env so SSR and the client's first render agree.
  // A post-mount effect then swaps in the persisted choice (if any) — also
  // runs before the URL-param hydration below so a deep-link env wins.
  const [selectedEnv, setSelectedEnv] = useState(environments[0]?.name ?? "");
  const [envHydrated, setEnvHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ENV_STORAGE_KEY);
      if (saved && environments.some((e) => e.name === saved) && saved !== selectedEnv) {
        setSelectedEnv(saved);
      }
    } catch { /* ignore */ }
    setEnvHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist after hydration so the initial render doesn't overwrite the
  // saved value with environments[0] before the effect above runs.
  useEffect(() => {
    if (!envHydrated || !selectedEnv) return;
    try { window.localStorage.setItem(ENV_STORAGE_KEY, selectedEnv); } catch { /* ignore */ }
  }, [envHydrated, selectedEnv]);
  const [view, setView] = useState<"tree" | "sections">("sections");
  // Hint that SectionsView uses for initial selection; cleared after first apply.
  const [preselect, setPreselect] = useState<{
    scope: string;
    item: string;
    fileName?: string;
    line?: number;
    query?: string;
  } | null>(null);

  // Hydrate env/scope/item from URL query params on mount so a "Find in Browse"
  // link from the Analyze page can deep-link into a specific item.
  // Accepts either (scope, item) or a richer (file, line) that resolves to
  // the audit item id server-side (needed for script content files whose
  // audit id is a UUID that can't be derived from the path alone).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const envParam = p.get("env") ?? p.get("environment");
    const scope = p.get("scope");
    const item = p.get("item");
    const file = p.get("file");
    const lineStr = p.get("line");
    const line = lineStr ? Number(lineStr) || undefined : undefined;
    const queryParam = p.get("q") ?? undefined;

    const envResolved = envParam && environments.some((e) => e.name === envParam) ? envParam : null;
    if (envResolved) setSelectedEnv(envResolved);

    if (file) {
      setView("sections");
      fetch(`/api/configs/${encodeURIComponent(envResolved ?? selectedEnv)}/resolve-file?path=${encodeURIComponent(file)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || data.error) return;
          setPreselect({
            scope: data.scope,
            item: data.itemId,
            fileName: data.fileName,
            line,
            query: queryParam,
          });
        })
        .catch(() => { /* ignore */ });
    } else if (scope || item) {
      setView("sections");
      setPreselect({ scope: scope ?? "", item: item ?? "", line, query: queryParam });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environments]);

  return (
    <div className="flex flex-col h-[calc(100vh-14rem)] gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-4 shrink-0">
        <select
          value={selectedEnv}
          onChange={(e) => setSelectedEnv(e.target.value)}
          className="px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
        >
          {environments.map((env) => (
            <option key={env.name} value={env.name}>{env.label}</option>
          ))}
        </select>

        {/* View toggle */}
        <div className="flex rounded-md border border-slate-200 overflow-hidden text-xs font-medium">
          <button
            type="button"
            onClick={() => setView("sections")}
            className={cn(
              "px-3 py-1.5 transition-colors",
              view === "sections" ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            Sections
          </button>
          <button
            type="button"
            onClick={() => setView("tree")}
            className={cn(
              "px-3 py-1.5 border-l border-slate-200 transition-colors",
              view === "tree" ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            Tree
          </button>
        </div>
      </div>

      {view === "sections"
        ? <SectionsView environment={selectedEnv} preselect={preselect} onPreselectApplied={() => setPreselect(null)} />
        : <TreeView environment={selectedEnv} />
      }
    </div>
  );
}

function countFiles(nodes: FileNode[]): number {
  return nodes.reduce((sum, n) => {
    if (n.type === "file") return sum + 1;
    return sum + countFiles(n.children ?? []);
  }, 0);
}
