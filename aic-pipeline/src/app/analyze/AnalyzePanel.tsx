"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { JourneyInfo, AnalyzeResult, AnalyzeSummary, ScriptUsage } from "@/app/api/analyze/route";
import type { ManagedObjectsReport } from "@/app/api/analyze/managed-objects/route";
import { JourneyForceGraph } from "./JourneyForceGraph";
import { ManagedObjectsGraph } from "./ManagedObjectsGraph";
import type { EsvOrphanReport, EsvOrphan, EsvReference } from "@/lib/analyze/esv-orphans";
import { FileContentViewer } from "@/components/FileContentViewer";
import { pathToScopeItem } from "@/lib/scope-paths";

type TaskId = "journeys" | "esv-orphans" | "managed-objects";

interface TaskDef {
  id: TaskId;
  name: string;
  description: string;
}

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

// "journeys" and "managed-objects" are hidden from the selector for now but
// their handlers and renderers remain wired so re-enabling is just a matter of
// uncommenting the entries here.
const TASKS: TaskDef[] = [
  // {
  //   id: "journeys",
  //   name: "Journey analysis",
  //   description: "Entry points, shared sub-journeys, orphans, and script usage across journeys.",
  // },
  // {
  //   id: "managed-objects",
  //   name: "Managed object schema",
  //   description: "Force-directed map of managed object types and the resourceCollection relationships between them.",
  // },
  {
    id: "esv-orphans",
    name: "ESV orphan references",
    description: "Find ESV placeholders and systemEnv lookups that aren't defined under esvs/.",
  },
];

const DEFAULT_TASK_ID: TaskId = "esv-orphans";

// ── Helpers ──────────────────────────────────────────────────────────────────

function classifyJourney(j: JourneyInfo): "root" | "shared" | "orphaned" | "leaf" | "internal" {
  if (j.calledBy.length === 0 && !j.innerTreeOnly) return "root";
  if (j.calledBy.length === 0 && j.innerTreeOnly)  return "orphaned";
  if (j.calledBy.length >= 2)                       return "shared";
  if (j.subJourneys.length === 0)                   return "leaf";
  return "internal";
}

const CLASS_STYLES: Record<ReturnType<typeof classifyJourney>, { dot: string; badge: string; label: string }> = {
  root:     { dot: "bg-sky-500",    badge: "bg-sky-100 text-sky-700 border-sky-200",       label: "Entry" },
  shared:   { dot: "bg-amber-400",  badge: "bg-amber-100 text-amber-700 border-amber-200", label: "Shared" },
  orphaned: { dot: "bg-red-400",    badge: "bg-red-100 text-red-700 border-red-200",       label: "Orphaned" },
  leaf:     { dot: "bg-slate-300",  badge: "bg-slate-100 text-slate-500 border-slate-200", label: "Leaf" },
  internal: { dot: "bg-violet-400", badge: "bg-violet-100 text-violet-700 border-violet-200", label: "Sub" },
};

// ── Summary Dashboard ─────────────────────────────────────────────────────────

function StatCard({ value, label, sub, color }: { value: number | string; label: string; sub?: string; color: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 flex flex-col gap-0.5">
      <span className={cn("text-2xl font-bold", color)}>{value}</span>
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {sub && <span className="text-[10px] text-slate-400">{sub}</span>}
    </div>
  );
}

function SummaryDashboard({ summary, journeys }: { summary: AnalyzeSummary; journeys: JourneyInfo[] }) {
  const entryJourneys = useMemo(
    () => journeys.filter((j) => j.calledBy.length === 0 && !j.innerTreeOnly).sort((a, b) => a.name.localeCompare(b.name)),
    [journeys]
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard value={summary.total}           label="Total Journeys"     color="text-slate-800" />
        <StatCard value={summary.roots}           label="Entry Points"       sub="not called by others" color="text-sky-600" />
        <StatCard value={summary.sharedSubJourneys} label="Shared Sub-Journeys" sub="called by 2+ parents" color="text-amber-600" />
        <StatCard value={summary.orphaned}        label="Orphaned"           sub="innerTreeOnly, no callers" color="text-red-500" />
        <StatCard value={summary.maxDepth}        label="Max Depth"          sub="longest chain" color="text-violet-600" />
      </div>

      {/* Entry Journeys */}
      {entryJourneys.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Entry Journeys ({entryJourneys.length})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {entryJourneys.map((j) => (
              <div key={j.name} className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" />
                <span className="text-slate-700 truncate" title={j.name}>{j.name}</span>
                <span className="text-[10px] text-slate-400 shrink-0">{j.nodeCount}n</span>
                {j.subJourneys.length > 0 && (
                  <span className="text-[10px] text-violet-500 shrink-0">{j.subJourneys.length} sub</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {summary.mostCalled.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Most-Called Sub-Journeys</h3>
          <div className="space-y-1.5">
            {summary.mostCalled.map((item) => (
              <div key={item.name} className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-slate-700 truncate block" title={item.name}>{item.name}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="h-1.5 rounded-full bg-amber-300" style={{ width: `${Math.round((item.count / summary.mostCalled[0].count) * 80) + 16}px` }} />
                  <span className="text-[11px] font-mono text-amber-700 w-6 text-right">{item.count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[11px]">
        {(Object.entries(CLASS_STYLES) as [ReturnType<typeof classifyJourney>, typeof CLASS_STYLES[keyof typeof CLASS_STYLES]][]).map(([key, s]) => (
          <span key={key} className="flex items-center gap-1.5 text-slate-500">
            <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", s.dot)} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Journey tree node ─────────────────────────────────────────────────────────

function JourneyTreeNode({
  name,
  journeyMap,
  depth,
  ancestors,
  searchQ,
  forceOpen,
}: {
  name: string;
  journeyMap: Map<string, JourneyInfo>;
  depth: number;
  ancestors: Set<string>;
  searchQ: string;
  forceOpen?: boolean;
}) {
  const info = journeyMap.get(name);
  const [open, setOpen] = useState(depth === 0);

  // React to parent expand/collapse all
  const prevForce = useState({ v: forceOpen })[0];
  if (forceOpen !== undefined && forceOpen !== prevForce.v) {
    prevForce.v = forceOpen;
    if (open !== forceOpen) setOpen(forceOpen);
  }

  if (!info) {
    // Referenced but not in config (pulled from different env, etc.)
    return (
      <div className="flex items-center gap-1.5 py-0.5 text-xs text-slate-400 italic">
        <span className="w-2 h-2 rounded-full bg-slate-200 shrink-0" />
        {name} <span className="text-[10px]">(not in config)</span>
      </div>
    );
  }

  const kind = classifyJourney(info);
  const s = CLASS_STYLES[kind];
  const isCycle = ancestors.has(name);
  const hasChildren = info.subJourneys.length > 0 && !isCycle;

  const nameMatches = searchQ ? name.toLowerCase().includes(searchQ) : true;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 rounded group",
          hasChildren && "cursor-pointer hover:bg-slate-50",
          !nameMatches && searchQ && "opacity-40",
        )}
        onClick={() => hasChildren && setOpen((o) => !o)}
      >
        {/* Expand arrow placeholder */}
        <span className="w-3 shrink-0 text-slate-400 text-[10px]">
          {hasChildren ? (open ? "▾" : "▸") : ""}
        </span>

        <span className={cn("w-2 h-2 rounded-full shrink-0", s.dot)} />

        <span className={cn("text-xs flex-1 min-w-0 truncate", depth === 0 ? "font-semibold text-slate-800" : "text-slate-700")} title={name}>
          {name}
        </span>

        {isCycle && <span className="text-[10px] text-orange-500 shrink-0">↺ cycle</span>}

        {info.calledBy.length >= 2 && (
          <span className="text-[10px] text-amber-600 shrink-0">{info.calledBy.length} parents</span>
        )}

        {!info.enabled && (
          <span className="text-[10px] text-slate-400 shrink-0">disabled</span>
        )}

        <span className={cn("text-[10px] px-1 py-0 rounded border shrink-0", s.badge)}>{s.label}</span>

        <span className="text-[10px] text-slate-400 shrink-0">{info.nodeCount}n</span>
      </div>

      {open && hasChildren && (
        <div className="ml-4 border-l border-slate-200 pl-3 mt-0.5 space-y-0.5">
          {info.subJourneys.map((sub) => (
            <JourneyTreeNode
              key={sub}
              name={sub}
              journeyMap={journeyMap}
              depth={depth + 1}
              ancestors={new Set([...ancestors, name])}
              searchQ={searchQ}
              forceOpen={forceOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Journey dependency tree ───────────────────────────────────────────────────

function JourneyDependencyTree({ journeys, searchQ }: { journeys: JourneyInfo[]; searchQ: string }) {
  const journeyMap = useMemo(() => new Map(journeys.map((j) => [j.name, j])), [journeys]);
  const [forceOpen, setForceOpen] = useState<boolean | undefined>(undefined);

  const expandAll = useCallback(() => setForceOpen(true), []);
  const collapseAll = useCallback(() => setForceOpen(false), []);

  const roots = useMemo(
    () => journeys.filter((j) => j.calledBy.length === 0 && !j.innerTreeOnly),
    [journeys],
  );

  const orphaned = useMemo(
    () => journeys.filter((j) => j.calledBy.length === 0 && j.innerTreeOnly),
    [journeys],
  );

  const filtered = useMemo(() => {
    if (!searchQ) return { roots, orphaned };
    const q = searchQ.toLowerCase();
    return {
      roots: roots.filter((j) => j.name.toLowerCase().includes(q) || j.subJourneys.some((s) => s.toLowerCase().includes(q))),
      orphaned: orphaned.filter((j) => j.name.toLowerCase().includes(q)),
    };
  }, [roots, orphaned, searchQ]);

  return (
    <div className="space-y-4">
      {/* Expand/Collapse All */}
      <div className="flex items-center gap-3">
        <button type="button" onClick={expandAll} className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
          Expand All
        </button>
        <button type="button" onClick={collapseAll} className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
          Collapse All
        </button>
      </div>

      {/* Entry-point journeys */}
      <div className="bg-white border border-slate-200 rounded-lg">
        <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-500 shrink-0" />
          <h3 className="text-sm font-semibold text-slate-700">Entry-Point Journeys</h3>
          <span className="text-xs text-slate-400">({filtered.roots.length})</span>
        </div>
        <div className="p-4 space-y-0.5">
          {filtered.roots.length === 0 ? (
            <p className="text-xs text-slate-400 italic">No entry-point journeys found.</p>
          ) : (
            filtered.roots.map((j) => (
              <JourneyTreeNode
                key={j.name}
                name={j.name}
                journeyMap={journeyMap}
                depth={0}
                ancestors={new Set()}
                searchQ={searchQ}
                forceOpen={forceOpen}
              />
            ))
          )}
        </div>
      </div>

      {/* Orphaned journeys */}
      {orphaned.length > 0 && (
        <div className="bg-white border border-red-100 rounded-lg">
          <div className="px-4 py-2.5 border-b border-red-100 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0" />
            <h3 className="text-sm font-semibold text-red-700">Orphaned Sub-Journeys</h3>
            <span className="text-xs text-red-400">({filtered.orphaned.length}) — innerTreeOnly but never called</span>
          </div>
          <div className="p-4 space-y-0.5">
            {filtered.orphaned.length === 0 ? (
              <p className="text-xs text-slate-400 italic">None match.</p>
            ) : (
              filtered.orphaned.map((j) => (
                <JourneyTreeNode
                  key={j.name}
                  name={j.name}
                  journeyMap={journeyMap}
                  depth={0}
                  ancestors={new Set()}
                  searchQ={searchQ}
                  forceOpen={forceOpen}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Script Usage ─────────────────────────────────────────────────────────────

function ScriptUsagePanel({ scripts }: { scripts: ScriptUsage[] }) {
  const [search, setSearch] = useState("");
  const [expandedUuid, setExpandedUuid] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<"all" | "used" | "unused">("all");

  const filtered = useMemo(() => {
    let list = scripts;
    if (filterMode === "used") list = list.filter((s) => s.usedBy.length > 0);
    else if (filterMode === "unused") list = list.filter((s) => s.usedBy.length === 0);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q) || s.uuid.toLowerCase().includes(q));
    }
    return list;
  }, [scripts, search, filterMode]);

  const usedCount = scripts.filter((s) => s.usedBy.length > 0).length;
  const unusedCount = scripts.length - usedCount;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="flex flex-wrap gap-3">
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2">
          <span className="text-lg font-bold text-slate-800">{scripts.length}</span>
          <span className="text-xs text-slate-500 ml-1.5">Total Scripts</span>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2">
          <span className="text-lg font-bold text-emerald-600">{usedCount}</span>
          <span className="text-xs text-slate-500 ml-1.5">Used in Journeys</span>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2">
          <span className="text-lg font-bold text-amber-600">{unusedCount}</span>
          <span className="text-xs text-slate-500 ml-1.5">Not Used</span>
        </div>
      </div>

      {/* Filter + Search */}
      <div className="flex items-center gap-3">
        <div className="flex rounded border border-slate-300 overflow-hidden text-xs shrink-0">
          {([
            { value: "all" as const, label: "All" },
            { value: "used" as const, label: `Used (${usedCount})` },
            { value: "unused" as const, label: `Unused (${unusedCount})` },
          ]).map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilterMode(f.value)}
              className={cn(
                "px-2.5 py-1 transition-colors",
                filterMode === f.value ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search scripts…"
          className="flex-1 text-xs rounded border border-slate-300 px-3 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
        {search && (
          <button type="button" onClick={() => setSearch("")} className="text-xs text-slate-400 hover:text-slate-600">Clear</button>
        )}
        <span className="text-xs text-slate-400 shrink-0">{filtered.length} / {scripts.length}</span>
      </div>

      {/* Script list */}
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-400">No scripts match the filter.</div>
        ) : (
          filtered.map((script) => {
            const isExpanded = expandedUuid === script.uuid;
            return (
              <div key={script.uuid}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-4 py-2 text-xs cursor-pointer hover:bg-slate-50 transition-colors",
                    isExpanded && "bg-slate-50"
                  )}
                  onClick={() => setExpandedUuid(isExpanded ? null : script.uuid)}
                >
                  <svg className="w-3.5 h-3.5 text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                  </svg>
                  <span className="text-slate-700 flex-1 truncate font-medium" title={script.name}>{script.name}</span>
                  <span className="text-[10px] text-slate-400 font-mono shrink-0">{script.context}</span>
                  {script.usedBy.length > 0 ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0">
                      {script.usedBy.length} {script.usedBy.length === 1 ? "journey" : "journeys"}
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">unused</span>
                  )}
                  <span className={cn("text-slate-400 text-[10px] transition-transform", isExpanded && "rotate-90")}>▶</span>
                </div>
                {isExpanded && (
                  <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 space-y-2">
                    <div className="text-[10px] text-slate-400 font-mono">{script.uuid}</div>
                    {script.usedBy.length === 0 ? (
                      <p className="text-xs text-slate-400 italic">Not referenced by any journey node.</p>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Used in:</p>
                        {script.usedBy.map((ref, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
                            <span className="text-slate-700 font-medium">{ref.journey}</span>
                            <span className="text-slate-400">→</span>
                            <span className="text-slate-500">{ref.nodeName}</span>
                            <span className="text-[10px] text-slate-400 font-mono">{ref.nodeType}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "analyze-state-v1";

interface PersistedState {
  taskId: TaskId;
  env: string;
  journeyResult: AnalyzeResult | null;
  esvResult: EsvOrphanReport | null;
  managedObjectsResult: ManagedObjectsReport | null;
}

function loadPersisted(): Partial<PersistedState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PersistedState>) : {};
  } catch { return {}; }
}

export function AnalyzePanel({ environments }: { environments: { name: string }[] }) {
  // Seed state from defaults only. Rehydrating from localStorage during the
  // initial render produces a hydration mismatch because localStorage is
  // browser-only. Load the persisted snapshot in a post-mount effect instead.
  const [taskId, setTaskId] = useState<TaskId>(DEFAULT_TASK_ID);
  const [env, setEnv] = useState(environments[0]?.name ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [journeyResult, setJourneyResult] = useState<AnalyzeResult | null>(null);
  const [esvResult, setEsvResult] = useState<EsvOrphanReport | null>(null);
  const [managedObjectsResult, setManagedObjectsResult] = useState<ManagedObjectsReport | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const currentTask = TASKS.find((t) => t.id === taskId) ?? TASKS[0];

  // Rehydrate from localStorage once, after mount, to avoid SSR/CSR mismatch.
  useEffect(() => {
    const p = loadPersisted();
    // If the persisted taskId refers to a hidden/removed task, fall back.
    if (p.taskId && TASKS.some((t) => t.id === p.taskId)) setTaskId(p.taskId);
    if (p.env) setEnv(p.env);
    if (p.journeyResult) setJourneyResult(p.journeyResult);
    if (p.esvResult) setEsvResult(p.esvResult);
    if (p.managedObjectsResult) setManagedObjectsResult(p.managedObjectsResult);
    setHydrated(true);
  }, []);

  // Persist state on every relevant change so a refresh brings the result back.
  useEffect(() => {
    if (!hydrated) return;
    try {
      const payload: PersistedState = { taskId, env, journeyResult, esvResult, managedObjectsResult };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch { /* ignore quota */ }
  }, [hydrated, taskId, env, journeyResult, esvResult, managedObjectsResult]);

  async function runTask() {
    setLoading(true);
    setError(null);
    const started = new Date();
    try {
      if (taskId === "journeys") {
        setJourneyResult(null);
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env }),
        });
        const data = await res.json();
        if (data.error) { setError(data.error); return; }
        const parsed = data as AnalyzeResult;
        setJourneyResult(parsed);
        postAnalyzeHistory({
          env,
          startedAt: started.toISOString(),
          durationMs: Date.now() - started.getTime(),
          summary: `Journey analysis · ${parsed.summary.total} journeys, ${parsed.summary.orphaned} orphaned, max depth ${parsed.summary.maxDepth}`,
          taskName: "Journey analysis",
        });
      } else if (taskId === "esv-orphans") {
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
      } else if (taskId === "managed-objects") {
        setManagedObjectsResult(null);
        const res = await fetch("/api/analyze/managed-objects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env }),
        });
        const data = await res.json();
        if (data.error) { setError(data.error); return; }
        const report = data as ManagedObjectsReport;
        setManagedObjectsResult(report);
        postAnalyzeHistory({
          env,
          startedAt: started.toISOString(),
          durationMs: Date.now() - started.getTime(),
          summary: `Managed object schema · ${report.types.length} types, ${report.relationships.length} relationships`,
          taskName: "Managed object schema",
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Task selector */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex items-start gap-4 flex-wrap">
        <div className="flex flex-col gap-1 min-w-[200px]">
          <label className="text-xs text-slate-500 font-medium">Task</label>
          <select
            value={taskId}
            onChange={(e) => { setTaskId(e.target.value as TaskId); setError(null); }}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-400"
          >
            {TASKS.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        <p className="flex-1 min-w-[200px] text-xs text-slate-500 pt-5">{currentTask.description}</p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 font-medium">Environment</label>
          <select
            value={env}
            onChange={(e) => { setEnv(e.target.value); setJourneyResult(null); setEsvResult(null); }}
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
          {loading ? "Analyzing…" : `Run ${currentTask.name}`}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">{error}</div>
      )}

      {/* Journey results — force-directed map of journeys + scripts */}
      {taskId === "journeys" && journeyResult && (
        <JourneyForceGraph journeys={journeyResult.journeys} scripts={journeyResult.scriptUsage} />
      )}

      {/* Managed object schema — layered ReactFlow + dagre map of types + relationships */}
      {taskId === "managed-objects" && managedObjectsResult && (
        <ManagedObjectsGraph
          types={managedObjectsResult.types}
          relationships={managedObjectsResult.relationships}
        />
      )}

      {/* ESV orphan results */}
      {taskId === "esv-orphans" && esvResult && (
        <EsvOrphanReportView report={esvResult} env={env} />
      )}
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
