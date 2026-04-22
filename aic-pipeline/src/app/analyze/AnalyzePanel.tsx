"use client";

import { useState, useMemo, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { EsvOrphanReport, EsvOrphan, EsvReference } from "@/lib/analyze/esv-orphans";
import { FileContentViewer } from "@/components/FileContentViewer";
import { pathToScopeItem } from "@/lib/scope-paths";

function postAnalyzeHistory(payload: {
  env: string;
  startedAt: string;
  durationMs: number;
  summary: string;
  taskName: string;
}) {
  fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "analyze",
      environment: payload.env,
      scopes: [],
      status: "success",
      startedAt: payload.startedAt,
      durationMs: payload.durationMs,
      summary: payload.summary,
      taskName: payload.taskName,
    }),
  }).catch(() => { /* non-fatal */ });
}

// ── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "analyze-state-v1";

interface PersistedState {
  env: string;
  esvResult: EsvOrphanReport | null;
}

function loadPersisted(): Partial<PersistedState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PersistedState>) : {};
  } catch { return {}; }
}

export function AnalyzePanel({ environments }: { environments: { name: string }[] }) {
  // Seed state from defaults only — rehydrate post-mount to dodge SSR mismatch.
  const [env, setEnv] = useState(environments[0]?.name ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [esvResult, setEsvResult] = useState<EsvOrphanReport | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const p = loadPersisted();
    if (p.env) setEnv(p.env);
    if (p.esvResult) setEsvResult(p.esvResult);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const payload: PersistedState = { env, esvResult };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch { /* ignore quota */ }
  }, [hydrated, env, esvResult]);

  async function runTask() {
    setLoading(true);
    setError(null);
    const started = new Date();
    try {
      setEsvResult(null);
      const res = await fetch("/api/analyze/esv-orphans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      const report = data as EsvOrphanReport;
      setEsvResult(report);
      postAnalyzeHistory({
        env,
        startedAt: started.toISOString(),
        durationMs: Date.now() - started.getTime(),
        summary: `ESV orphans · ${report.orphans.length} orphan${report.orphans.length === 1 ? "" : "s"}, ${report.unused.length} unused, ${report.totalReferences} refs across ${report.scannedFiles} files`,
        taskName: "ESV orphan references",
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Task description */}
      <div className="bg-white border border-slate-200 rounded-lg p-3">
        <div className="text-sm font-medium text-slate-700">ESV orphan references</div>
        <p className="text-xs text-slate-500 mt-1">
          Find ESV placeholders and systemEnv lookups that aren&apos;t defined under <code>esvs/</code>.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 font-medium">Environment</label>
          <select
            value={env}
            onChange={(e) => { setEnv(e.target.value); setEsvResult(null); }}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-400"
          >
            {environments.map((e) => (
              <option key={e.name} value={e.name}>{e.name}</option>
            ))}
          </select>
        </div>

        <button
          onClick={runTask}
          disabled={loading || !env}
          className="px-4 py-1.5 text-sm bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Analyzing…" : "Run ESV orphan references"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">{error}</div>
      )}

      {/* Report */}
      {esvResult && <EsvOrphanReportView report={esvResult} env={env} />}
    </div>
  );
}

// ── ESV Orphan report view ────────────────────────────────────────────────────

function EsvOrphanReportView({ report, env }: { report: EsvOrphanReport; env: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [showUnused, setShowUnused] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<{ path: string; line: number } | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);

  const visibleOrphans = useMemo(() => {
    if (!query.trim()) return report.orphans;
    const q = query.trim().toLowerCase();
    return report.orphans.filter((o) =>
      o.name.toLowerCase().includes(q) ||
      o.references.some((r) => r.path.toLowerCase().includes(q))
    );
  }, [report.orphans, query]);

  // Reset pagination when the filter or underlying report changes.
  useEffect(() => { setPage(0); }, [query, report]);

  const totalPages = Math.max(1, Math.ceil(visibleOrphans.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStartIdx = currentPage * pageSize;
  const pageEndIdx = Math.min(pageStartIdx + pageSize, visibleOrphans.length);
  const pagedOrphans = visibleOrphans.slice(pageStartIdx, pageEndIdx);

  // Fetch the selected file through the existing configs endpoint.
  useEffect(() => {
    if (!selected) { setFileContent(""); return; }
    const ctl = new AbortController();
    setFileLoading(true);
    fetch(`/api/configs/${encodeURIComponent(env)}/file?path=${encodeURIComponent(selected.path)}`, { signal: ctl.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => setFileContent(d.content ?? ""))
      .catch((e) => { if ((e as Error).name !== "AbortError") setFileContent(`// failed to load: ${(e as Error).message}`); })
      .finally(() => setFileLoading(false));
    return () => ctl.abort();
  }, [selected, env]);

  const toggle = (name: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const expandAll = () => setExpanded(new Set(pagedOrphans.map((o) => o.name)));
  const collapseAll = () => setExpanded(new Set());
  const openReference = (r: EsvReference) => setSelected({ path: r.path, line: r.line });

  const tsStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `esv-orphans-${env}-${tsStamp()}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const rows: string[] = ["esv_name,form,file,line,snippet"];
    const escape = (v: string) => {
      const needs = /[",\n]/.test(v);
      const q = v.replace(/"/g, '""');
      return needs ? `"${q}"` : q;
    };
    for (const o of report.orphans) {
      for (const r of o.references) {
        rows.push([escape(o.name), escape(r.form), escape(r.path), String(r.line), escape(r.snippet)].join(","));
      }
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `esv-orphans-${env}-${tsStamp()}.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat value={report.orphans.length} label="Orphan ESVs" sub="referenced, not defined" color="text-rose-600" />
        <Stat value={report.unused.length} label="Unused ESVs" sub="defined, not referenced" color="text-amber-600" />
        <Stat value={report.totalReferences} label="Total references" sub={`across ${report.scannedFiles.toLocaleString()} files`} color="text-slate-800" />
        <Stat value={report.totalDefinedNames} label="Defined ESVs" color="text-sky-600" />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter orphan name or file path…"
          className="flex-1 min-w-[220px] text-xs rounded border border-slate-300 px-3 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
        <button type="button" onClick={expandAll} className="text-[11px] text-slate-500 hover:text-slate-800">
          Expand all
        </button>
        <span className="text-slate-300 text-[10px]">·</span>
        <button type="button" onClick={collapseAll} className="text-[11px] text-slate-500 hover:text-slate-800">
          Collapse all
        </button>
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={exportJson}
            disabled={report.orphans.length === 0}
            className="px-2 py-0.5 text-[11px] font-medium rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export full report as JSON"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={report.orphans.length === 0}
            className="px-2 py-0.5 text-[11px] font-medium rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export orphan references as CSV"
          >
            Export CSV
          </button>
          <span className="text-slate-300 text-[10px]">·</span>
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
            <input type="checkbox" checked={showUnused} onChange={(e) => setShowUnused(e.target.checked)} className="accent-sky-600" />
            Show unused defined ESVs
          </label>
        </div>
      </div>

      {/* Orphans list + file preview split */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col">
          <div className="px-4 py-2 border-b border-slate-100 bg-rose-50/40 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
            Orphan references — {visibleOrphans.length} {visibleOrphans.length === 1 ? "name" : "names"}
          </div>
          {visibleOrphans.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">
              {report.orphans.length === 0 ? "No orphan ESV references — every placeholder resolves." : "No matches."}
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-100 flex-1 overflow-y-auto">
                {pagedOrphans.map((o) => {
                  const open = expanded.has(o.name);
                  return (
                    <OrphanRow
                      key={o.name}
                      orphan={o}
                      open={open}
                      onToggle={() => toggle(o.name)}
                      onOpenReference={openReference}
                      selected={selected}
                    />
                  );
                })}
              </div>
              {/* Pagination */}
              {visibleOrphans.length > pageSize && (
                <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 bg-slate-50/50 shrink-0">
                  <span className="text-[11px] text-slate-500">
                    Showing {pageStartIdx + 1}–{pageEndIdx} of {visibleOrphans.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      value={pageSize}
                      onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
                      className="text-[11px] rounded border border-slate-300 px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
                    >
                      {[10, 25, 50, 100].map((s) => (
                        <option key={s} value={s}>{s} / page</option>
                      ))}
                    </select>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => setPage(0)} disabled={currentPage <= 0} className="px-2 py-0.5 text-[11px] rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">First</button>
                      <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={currentPage <= 0} className="px-2 py-0.5 text-[11px] rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">←</button>
                      <span className="text-[11px] text-slate-500 px-1 tabular-nums">{currentPage + 1} / {totalPages}</span>
                      <button type="button" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={currentPage >= totalPages - 1} className="px-2 py-0.5 text-[11px] rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">→</button>
                      <button type="button" onClick={() => setPage(totalPages - 1)} disabled={currentPage >= totalPages - 1} className="px-2 py-0.5 text-[11px] rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">Last</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* File preview */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col min-h-[300px] max-h-[calc(100vh-260px)]">
          {selected ? (
            <>
              <div className="px-4 py-2 border-b border-slate-200 bg-slate-50/50 flex items-center gap-3">
                {(() => {
                  const parsed = pathToScopeItem(selected.path);
                  const itemName = parsed?.item || selected.path.split("/").pop() || selected.path;
                  return (
                    <>
                      <span className="text-xs font-mono text-slate-700 truncate flex-1 min-w-0" title={selected.path}>
                        {parsed?.scope ? (
                          <span className="text-slate-400">{parsed.scope} / </span>
                        ) : null}
                        <span className="text-slate-800">{itemName}</span>
                      </span>
                      {parsed && parsed.item && (
                        <a
                          href={`/configs?env=${encodeURIComponent(env)}&file=${encodeURIComponent(selected.path)}&line=${selected.line}`}
                          target="_blank"
                          rel="noopener"
                          className="text-[11px] text-sky-600 hover:text-sky-800 hover:underline shrink-0"
                          title="Open this item in the Browse tab"
                        >
                          Find in Browse ↗
                        </a>
                      )}
                    </>
                  );
                })()}
                <span className="text-[10px] text-slate-400 shrink-0">line {selected.line}</span>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="text-slate-400 hover:text-slate-700 text-xs shrink-0"
                  title="Close preview"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                {fileLoading ? (
                  <div className="p-4 text-slate-400 text-xs">Loading…</div>
                ) : (
                  <FileContentViewer
                    content={fileContent}
                    fileName={selected.path}
                    highlightLine={selected.line}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center flex-1 text-xs text-slate-400">
              Click a reference to preview the file
            </div>
          )}
        </div>
      </div>

      {/* Unused list */}
      {showUnused && report.unused.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-100 bg-amber-50/40 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
            Unused defined ESVs — {report.unused.length}
          </div>
          <div className="divide-y divide-slate-100">
            {report.unused.map((u) => (
              <div key={u.name} className="flex items-center gap-3 px-4 py-1.5 text-xs">
                <span className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-semibold",
                  u.kind === "secret" ? "bg-rose-100 text-rose-700" : "bg-sky-100 text-sky-700"
                )}>{u.kind}</span>
                <span className="font-mono text-slate-800 flex-1 truncate">{u.name}</span>
                <span className="font-mono text-slate-400 text-[10px] truncate">{u.file}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, sub, color }: { value: number | string; label: string; sub?: string; color: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
      <div className={cn("text-2xl font-bold", color)}>{value}</div>
      <div className="text-xs font-medium text-slate-600">{label}</div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

/** Group an orphan's references by derived scope. Unresolvable paths fall into "other". */
function groupRefsByScope(refs: EsvReference[]): { scope: string; refs: EsvReference[] }[] {
  const byScope = new Map<string, EsvReference[]>();
  for (const r of refs) {
    const parsed = pathToScopeItem(r.path);
    const scope = parsed?.scope ?? "other";
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope)!.push(r);
  }
  return Array.from(byScope.entries())
    .map(([scope, refs]) => ({ scope, refs }))
    .sort((a, b) => (a.scope === "other" ? 1 : b.scope === "other" ? -1 : a.scope.localeCompare(b.scope)));
}

/** Derive the item label for a reference path (basename fallback). */
function refItemLabel(path: string): string {
  const parsed = pathToScopeItem(path);
  if (parsed?.item) return parsed.item;
  const segs = path.replace(/\\/g, "/").split("/");
  return segs[segs.length - 1] ?? path;
}

function OrphanRow({
  orphan, open, onToggle, onOpenReference, selected,
}: {
  orphan: EsvOrphan;
  open: boolean;
  onToggle: () => void;
  onOpenReference: (r: EsvReference) => void;
  selected: { path: string; line: number } | null;
}) {
  const fileCount = new Set(orphan.references.map((r) => r.path)).size;
  const grouped = useMemo(() => groupRefsByScope(orphan.references), [orphan.references]);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-slate-50 transition-colors"
      >
        <span className="text-slate-400 text-[10px] w-3">{open ? "▾" : "▸"}</span>
        <span className="font-mono text-xs text-rose-700 font-semibold flex-1 truncate">{orphan.name}</span>
        <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
          {orphan.references.length} ref{orphan.references.length === 1 ? "" : "s"} · {fileCount} file{fileCount === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="bg-slate-50/60 px-4 pb-3 pt-1 space-y-2">
          {grouped.map((group) => (
            <div key={group.scope} className="space-y-0.5">
              <div className="flex items-center gap-2 pl-1.5 pt-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {group.scope}
                </span>
                <span className="text-[10px] text-slate-400 tabular-nums">
                  {group.refs.length} ref{group.refs.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-0.5">
                {group.refs.map((r, i) => {
                  const isActive = !!selected && selected.path === r.path && selected.line === r.line;
                  return <RefLine key={i} reference={r} active={isActive} onOpen={() => onOpenReference(r)} />;
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RefLine({ reference, active, onOpen }: { reference: EsvReference; active: boolean; onOpen: () => void }) {
  const formBadge = reference.form === "placeholder"
    ? { label: "&{esv}", cls: "bg-sky-100 text-sky-700" }
    : reference.form === "realmPlaceholder"
    ? { label: "fr.realm", cls: "bg-indigo-100 text-indigo-700" }
    : { label: "systemEnv", cls: "bg-violet-100 text-violet-700" };
  const item = refItemLabel(reference.path);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "w-full flex items-start gap-2 text-[11px] font-mono text-left rounded px-1.5 py-0.5 transition-colors border-l-2",
        active
          ? "bg-sky-100/80 border-sky-500"
          : "hover:bg-sky-50 border-transparent"
      )}
      title={`${reference.path}:${reference.line}`}
    >
      <span className={cn("shrink-0 px-1.5 py-0 rounded text-[10px] font-semibold", formBadge.cls)}>{formBadge.label}</span>
      <span className="shrink-0 text-slate-400 tabular-nums">{reference.line}</span>
      <span className="shrink-0 text-sky-700 hover:underline truncate max-w-[260px]" title={reference.path}>{item}</span>
      <span className="flex-1 text-slate-500 break-all">{reference.snippet}</span>
    </button>
  );
}
