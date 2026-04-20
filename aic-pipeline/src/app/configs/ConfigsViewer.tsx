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
import { WorkflowGraph } from "./WorkflowGraph";

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

  const handleFileSelect = async (relativePath: string, name: string, line?: number) => {
    setSelectedFile(relativePath);
    setSelectedFileName(name);
    setFileContent(null);
    setFileLoading(true);
    setHighlightLine(line);
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
              {esvMeta && (
                <button
                  type="button"
                  title={`Find usages of esv-${esvMeta.name}`}
                  onClick={handleFindUsages}
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium rounded border border-sky-600 bg-sky-700/30 text-sky-200 hover:bg-sky-600/40 transition-colors"
                >
                  Find usages
                </button>
              )}
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
              <FullscreenButton fullscreen={fullscreen} onToggle={() => setFullscreen((f) => !f)} dark />
            </div>
            {usagesOpen && esvMeta && (
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
              {fileLoading && <div className="flex items-center justify-center h-full text-sm text-slate-500">Loading…</div>}
              {!fileLoading && fileContent !== null && <FileContent content={fileContent} fileName={selectedFileName ?? ""} highlightLine={highlightLine} />}
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
  preselect?: { scope: string; item: string; fileName?: string; line?: number } | null;
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

  // Reset usage panel when item changes
  useEffect(() => { setUsageOpen(false); setUsageData(null); setEndpointUsageData(null); setJourneyUsageData(null); }, [selectedItem]);

  // Track the file name + line to highlight after files load (deep-link flow).
  const pendingFileSelection = useRef<{ fileName?: string; line?: number } | null>(null);
  const [highlightLine, setHighlightLine] = useState<number | undefined>(undefined);

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
        if (preselect.fileName || preselect.line) {
          pendingFileSelection.current = { fileName: preselect.fileName, line: preselect.line };
        }
      }
    }
    onPreselectApplied?.();
  }, [preselect, auditData, auditLoading, onPreselectApplied]);

  // Clear highlight when the user navigates to a different item.
  useEffect(() => { setHighlightLine(undefined); }, [selectedItem]);

  const fetchUsage = useCallback(() => {
    if (!selectedItem || selectedScope !== "scripts") return;
    setUsageOpen(true);
    setUsageLoading(true);
    fetch(`/api/analyze/script-usage?env=${encodeURIComponent(environment)}&scriptId=${encodeURIComponent(selectedItem.id.replace(".json", ""))}`)
      .then((r) => r.json())
      .then((data) => setUsageData(data.usedBy ?? []))
      .catch(() => setUsageData([]))
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
              {filteredItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedItem(item)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs transition-colors truncate border-l-2",
                    selectedItem?.id === item.id
                      ? "border-sky-500 bg-sky-50 text-sky-700 font-medium"
                      : "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-800"
                  )}
                >
                  {item.label}
                </button>
              ))}
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
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                  )}
                </button>
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
                ) : !usageData || usageData.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">Not used in any journey.</p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">
                      Used in {usageData.length} {usageData.length === 1 ? "place" : "places"}
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

            {/* Content */}
            <div className="flex-1 overflow-hidden min-h-0">
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
                <div className="h-full">
                  <JourneyGraph json={activeFile.content} fitViewKey={fullscreen ? 1 : 0} environment={environment} journeyId={selectedItem?.id} focusNodeId={focusNodeId} />
                </div>
              )}
              {!fileLoading && files && files.length > 0 && selectedScope === "iga-workflows" && (
                <div className="h-full">
                  <WorkflowGraph files={files} workflowId={selectedItem?.id} />
                </div>
              )}
              {!fileLoading && activeFile && selectedScope !== "journeys" && selectedScope !== "iga-workflows" && (
                activeFile.name.toLowerCase().endsWith(".json") ? (
                  <div className="h-full min-h-0 overflow-hidden">
                    <JsonFileViewer
                      key={`${selectedItem?.id ?? ""}:${activeFile.name}:${isEsvScope(selectedScope) ? esvMode : ""}`}
                      content={isEsvScope(selectedScope) ? applyEsvDecoding(activeFile.content, esvMode) : activeFile.content}
                      fileName={activeFile.name}
                      highlightLine={highlightLine}
                    />
                  </div>
                ) : (activeFile.name.toLowerCase().endsWith(".js") || activeFile.name.toLowerCase().endsWith(".groovy")) ? (
                  <div className="h-full min-h-0 overflow-hidden">
                    <ScriptFileViewer
                      key={`${selectedItem?.id ?? ""}:${activeFile.name}`}
                      content={activeFile.content}
                      fileName={activeFile.name}
                      environment={environment}
                      relPath={activeFile.relPath}
                      highlightLine={highlightLine}
                      onNavigate={handleNavigateTarget}
                    />
                  </div>
                ) : (
                  <div className="overflow-auto h-full">
                    <FileContent
                      content={activeFile.content}
                      fileName={activeFile.name}
                      highlightLine={highlightLine}
                      wrap={(selectedScope === "scripts" || selectedScope === "endpoints") && wrapScripts}
                    />
                  </div>
                )
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
          });
        })
        .catch(() => { /* ignore */ });
    } else if (scope || item) {
      setView("sections");
      setPreselect({ scope: scope ?? "", item: item ?? "", line });
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
