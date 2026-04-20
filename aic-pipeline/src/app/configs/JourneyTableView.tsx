"use client";

import { useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ScriptOverlay } from "./ScriptOverlay";

// ── Constants ─────────────────────────────────────────────────────────────────

const SUCCESS_ID = "e301438c-0bd0-429c-ab0c-66126501069a";
const FAILURE_ID = "70e691a5-1e33-4ac3-a356-e7b6d60d92e0";

const TYPE_COLORS: Partial<Record<string, string>> = {
  ScriptedDecisionNode:   "bg-violet-100 text-violet-700 border-violet-200",
  InnerTreeEvaluatorNode: "bg-amber-100  text-amber-700  border-amber-200",
  PageNode:               "bg-indigo-100 text-indigo-700 border-indigo-200",
};
const TYPE_COLOR_DEFAULT = "bg-slate-100 text-slate-600 border-slate-200";

// ── Types ─────────────────────────────────────────────────────────────────────

interface JourneyNode {
  displayName?: string;
  nodeType?: string;
  connections?: Record<string, string>;
}

interface JourneyJson {
  nodes?: Record<string, JourneyNode>;
}

interface TableRow {
  id: string;
  name: string;
  nodeType: string;
  outcomes: string[];
  connectsTo: { label: string; id: string }[];
}

type SortCol = "name" | "type" | "outcomes";
type SortDir = "asc" | "desc";

// ── Parser ────────────────────────────────────────────────────────────────────

function parseTable(json: string): TableRow[] {
  try {
    const data = JSON.parse(json) as JourneyJson;
    const nodes = data.nodes ?? {};

    const nameMap = new Map<string, string>();
    nameMap.set(SUCCESS_ID, "Success");
    nameMap.set(FAILURE_ID, "Failure");
    nameMap.set("startNode", "Start");
    Object.entries(nodes).forEach(([id, n]) => {
      nameMap.set(id, n.displayName ?? id.slice(0, 8));
    });

    return Object.entries(nodes).map(([id, n]) => ({
      id,
      name:      n.displayName ?? id.slice(0, 8),
      nodeType:  n.nodeType ?? "Unknown",
      outcomes:  Object.keys(n.connections ?? {}),
      connectsTo: Object.entries(n.connections ?? {}).map(([, targetId]) => ({
        id:    targetId,
        label: nameMap.get(targetId) ?? targetId.slice(0, 8),
      })),
    }));
  } catch {
    return [];
  }
}

// ── Sort helper ───────────────────────────────────────────────────────────────

function sortRows(rows: TableRow[], col: SortCol, dir: SortDir): TableRow[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (col === "name")     cmp = a.name.localeCompare(b.name);
    if (col === "type")     cmp = a.nodeType.localeCompare(b.nodeType);
    if (col === "outcomes") cmp = a.outcomes.length - b.outcomes.length;
    return dir === "asc" ? cmp : -cmp;
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SortIcon({ col, active, dir }: { col: string; active: boolean; dir: SortDir }) {
  return (
    <span className={cn("ml-1 text-[9px]", active ? "text-slate-700" : "text-slate-300")}>
      {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className={cn(
      "text-[9px] font-medium rounded px-1.5 py-0.5 border leading-none whitespace-nowrap",
      TYPE_COLORS[type] ?? TYPE_COLOR_DEFAULT,
    )}>
      {type}
    </span>
  );
}

// ── Public export ─────────────────────────────────────────────────────────────

export function JourneyTableView({ json, environment, journeyId }: { json: string; environment?: string; journeyId?: string }) {
  const allRows = useMemo(() => parseTable(json), [json]);

  const nodeTypes = useMemo(
    () => ["All", ...Array.from(new Set(allRows.map((r) => r.nodeType))).sort()],
    [allRows],
  );

  const [search,    setSearch]    = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [sortCol,   setSortCol]   = useState<SortCol>("name");
  const [sortDir,   setSortDir]   = useState<SortDir>("asc");

  const [scriptOverlay, setScriptOverlay] = useState<{ name: string; content: string } | null>(null);
  const [scriptLoading, setScriptLoading] = useState<string | null>(null); // nodeId being loaded

  const handleViewScript = useCallback(async (nodeId: string) => {
    if (!environment || !journeyId || scriptLoading) return;
    setScriptLoading(nodeId);
    try {
      const nodeParams = new URLSearchParams({ environment, journey: journeyId, nodeId });
      const nodeRes = await fetch(`/api/push/journey-node?${nodeParams}`);
      const nodeData = await nodeRes.json();
      const config = JSON.parse(nodeData.file?.content ?? "{}");
      const scriptId = typeof config.script === "string" ? config.script : null;
      if (!scriptId) return;

      const scriptParams = new URLSearchParams({ environment, scriptId });
      const scriptRes = await fetch(`/api/push/script?${scriptParams}`);
      const scriptData = await scriptRes.json();
      if (scriptData.content) {
        setScriptOverlay({ name: scriptData.name ?? scriptId, content: scriptData.content });
      }
    } catch {
      // silently ignore
    } finally {
      setScriptLoading(null);
    }
  }, [environment, journeyId, scriptLoading]);

  const rows = useMemo(() => {
    let r = allRows;
    if (typeFilter !== "All") r = r.filter((row) => row.nodeType === typeFilter);
    if (search.trim())        r = r.filter((row) => row.name.toLowerCase().includes(search.toLowerCase()));
    return sortRows(r, sortCol, sortDir);
  }, [allRows, typeFilter, search, sortCol, sortDir]);

  function handleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-50">
      {scriptOverlay && (
        <ScriptOverlay
          name={scriptOverlay.name}
          content={scriptOverlay.content}
          onClose={() => setScriptOverlay(null)}
        />
      )}
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white shrink-0">
        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="text-[11px] border border-slate-200 rounded px-2 py-1 w-44 outline-none focus:border-sky-400 bg-white text-slate-700 placeholder:text-slate-300"
        />

        {/* Type filter */}
        <div className="flex flex-wrap gap-1">
          {nodeTypes.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              className={cn(
                "text-[9px] font-medium rounded px-2 py-0.5 border transition-colors",
                typeFilter === t
                  ? "bg-slate-700 text-white border-slate-700"
                  : (TYPE_COLORS[t] ?? "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"),
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[10px] text-slate-400 shrink-0">{rows.length} node{rows.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead className="sticky top-0 bg-white border-b border-slate-200 z-10">
            <tr>
              <th
                className="text-left px-4 py-2 font-semibold text-slate-600 cursor-pointer hover:text-slate-900 whitespace-nowrap select-none w-[30%]"
                onClick={() => handleSort("name")}
              >
                Name <SortIcon col="name" active={sortCol === "name"} dir={sortDir} />
              </th>
              <th
                className="text-left px-4 py-2 font-semibold text-slate-600 cursor-pointer hover:text-slate-900 whitespace-nowrap select-none w-[22%]"
                onClick={() => handleSort("type")}
              >
                Type <SortIcon col="type" active={sortCol === "type"} dir={sortDir} />
              </th>
              <th
                className="text-left px-4 py-2 font-semibold text-slate-600 cursor-pointer hover:text-slate-900 whitespace-nowrap select-none w-[20%]"
                onClick={() => handleSort("outcomes")}
              >
                Outcomes <SortIcon col="outcomes" active={sortCol === "outcomes"} dir={sortDir} />
              </th>
              <th className="text-left px-4 py-2 font-semibold text-slate-600 whitespace-nowrap w-[28%]">
                Connects To
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">No nodes match</td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr
                key={row.id}
                className={cn("border-b border-slate-100 hover:bg-white transition-colors", i % 2 === 0 ? "bg-slate-50" : "bg-white")}
              >
                {/* Name */}
                <td className="px-4 py-2 font-medium text-slate-700 max-w-0">
                  {row.nodeType === "ScriptedDecisionNode" && environment && journeyId ? (
                    <button
                      type="button"
                      onClick={() => handleViewScript(row.id)}
                      disabled={scriptLoading === row.id}
                      className="truncate block text-left text-violet-600 hover:text-violet-800 hover:underline disabled:opacity-40 transition-colors w-full"
                    >
                      {scriptLoading === row.id ? (
                        <span className="flex items-center gap-1">
                          <svg className="w-3 h-3 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                          </svg>
                          {row.name}
                        </span>
                      ) : row.name}
                    </button>
                  ) : (
                    <span className="truncate block">{row.name}</span>
                  )}
                </td>

                {/* Type */}
                <td className="px-4 py-2">
                  <TypeBadge type={row.nodeType} />
                </td>

                {/* Outcomes */}
                <td className="px-4 py-2 text-slate-500 max-w-0">
                  {row.outcomes.length === 0 ? (
                    <span className="text-slate-300">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {row.outcomes.map((o) => (
                        <span key={o} className="font-mono bg-slate-100 text-slate-500 rounded px-1 py-0.5 text-[9px] leading-none">
                          {o}
                        </span>
                      ))}
                    </div>
                  )}
                </td>

                {/* Connects To */}
                <td className="px-4 py-2 text-slate-500 max-w-0">
                  <div className="flex flex-wrap gap-1">
                    {row.connectsTo.map((t, j) => (
                      <span
                        key={j}
                        className={cn(
                          "text-[10px] rounded px-1.5 py-0.5 leading-none",
                          t.id === SUCCESS_ID ? "bg-emerald-50 text-emerald-600" :
                          t.id === FAILURE_ID ? "bg-rose-50 text-rose-600" :
                                                "bg-slate-100 text-slate-600",
                        )}
                      >
                        {t.label}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
