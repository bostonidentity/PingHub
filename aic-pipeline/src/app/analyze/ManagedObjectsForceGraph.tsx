"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ForceGraphMethods } from "react-force-graph-2d";
import type { ManagedObjectType, ManagedObjectRelationship } from "@/app/api/analyze/managed-objects/route";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type Category = "core" | "identity" | "custom";

interface GNode {
  id: string;
  name: string;
  degree: number;
  category: Category;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

interface GLink {
  source: string;
  target: string;
  field: string;
  isArray: boolean;
  isReverse: boolean;
}

/** Heuristic categorization just for visual grouping. */
function categorize(name: string): Category {
  const lower = name.toLowerCase();
  if (lower.includes("custom") || lower.includes("nik")) return "custom";
  const core = ["user", "role", "group", "organization", "assignment", "application"];
  for (const c of core) if (lower.endsWith(c) || lower.endsWith(`_${c}`) || lower === c) return "core";
  return "identity";
}

function buildGraph(
  types: ManagedObjectType[],
  relationships: ManagedObjectRelationship[],
): { nodes: GNode[]; links: GLink[] } {
  const byName = new Map<string, GNode>();
  for (const t of types) {
    byName.set(t.name, {
      id: t.name,
      name: t.name,
      degree: t.incomingCount + t.outgoingCount,
      category: categorize(t.name),
    });
  }
  const links: GLink[] = [];
  for (const r of relationships) {
    if (!byName.has(r.source) || !byName.has(r.target)) continue;
    links.push({
      source: r.source,
      target: r.target,
      field: r.field,
      isArray: r.isArray,
      isReverse: r.isReverse,
    });
  }
  return { nodes: [...byName.values()], links };
}

function nodeRadius(n: GNode): number {
  return 3.5 + Math.min(14, Math.sqrt(n.degree) * 2.4);
}

const CATEGORY_COLOR: Record<Category, string> = {
  core: "#ffffff",        // pinned staples — user/role/group/etc.
  identity: "#cbd5e1",    // slate-300 — other project-specific types
  custom: "#a78bfa",      // violet-400 — *custom*, *nik* suffixed types
};

function nodeColor(n: GNode, hovered: string | null, selected: string | null, connected: Set<string>): string {
  if (selected === n.id) return "#facc15";
  if (hovered === n.id) return "#7dd3fc";
  if (connected.size > 0 && !connected.has(n.id)) return "#1f2937";
  return CATEGORY_COLOR[n.category];
}

interface Props {
  types: ManagedObjectType[];
  relationships: ManagedObjectRelationship[];
}

/**
 * Force-directed view of the managed-object schema: each node is a
 * managed object type, each edge is a `resourceCollection` reference.
 * Click a type to focus its neighborhood; toggle category visibility
 * via the legend.
 */
export function ManagedObjectsForceGraph({ types, relationships }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCore, setShowCore] = useState(true);
  const [showIdentity, setShowIdentity] = useState(true);
  const [showCustom, setShowCustom] = useState(true);
  const [hideReverse, setHideReverse] = useState(true);
  const [filter, setFilter] = useState("");
  const [includeNeighbors, setIncludeNeighbors] = useState(true);

  const full = useMemo(() => buildGraph(types, relationships), [types, relationships]);

  // Adjacency on the full (unfiltered) graph — used to expand a name filter
  // to include direct neighbors of matches.
  const fullAdj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of full.links) {
      const s = typeof l.source === "string" ? l.source : (l.source as GNode).id;
      const t = typeof l.target === "string" ? l.target : (l.target as GNode).id;
      if (!m.has(s)) m.set(s, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t);
      m.get(t)!.add(s);
    }
    return m;
  }, [full.links]);

  const data = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matchesFilter = (n: GNode) => !q || n.name.toLowerCase().includes(q);

    // Filter set: matches (+ their neighbors when includeNeighbors is on).
    const filterSet = new Set<string>();
    if (q) {
      for (const n of full.nodes) if (matchesFilter(n)) filterSet.add(n.id);
      if (includeNeighbors) {
        const expanded = new Set(filterSet);
        for (const id of filterSet) {
          for (const nb of fullAdj.get(id) ?? []) expanded.add(nb);
        }
        filterSet.clear();
        for (const id of expanded) filterSet.add(id);
      }
    }

    const nodeVisible = (n: GNode) => {
      if (q && !filterSet.has(n.id)) return false;
      if (n.category === "core") return showCore;
      if (n.category === "custom") return showCustom;
      return showIdentity;
    };
    const keptNodes = full.nodes.filter(nodeVisible);
    const keptIds = new Set(keptNodes.map((n) => n.id));
    const keptLinks = full.links.filter((l) => {
      if (hideReverse && l.isReverse) return false;
      const s = typeof l.source === "string" ? l.source : (l.source as GNode).id;
      const t = typeof l.target === "string" ? l.target : (l.target as GNode).id;
      return keptIds.has(s) && keptIds.has(t);
    });
    return { nodes: keptNodes, links: keptLinks };
  }, [full, fullAdj, showCore, showIdentity, showCustom, hideReverse, filter, includeNeighbors]);

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const l of data.links) {
      const s = typeof l.source === "string" ? l.source : (l.source as GNode).id;
      const t = typeof l.target === "string" ? l.target : (l.target as GNode).id;
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  }, [data.links]);

  const connected = useMemo(() => {
    const focus = selected ?? hovered;
    if (!focus) return new Set<string>();
    const s = new Set<string>([focus]);
    for (const n of neighbors.get(focus) ?? []) s.add(n);
    return s;
  }, [hovered, selected, neighbors]);

  // Types that always show a label: core ones + top-N by degree.
  const alwaysLabelled = useMemo(() => {
    const s = new Set<string>();
    for (const n of data.nodes) if (n.category === "core") s.add(n.id);
    const top = [...data.nodes].sort((a, b) => b.degree - a.degree).slice(0, 8);
    for (const n of top) s.add(n.id);
    return s;
  }, [data.nodes]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setDims({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    fgRef.current?.d3ReheatSimulation();
  }, [data]);

  return (
    <div
      ref={wrapperRef}
      className="relative rounded-lg border border-slate-800 bg-slate-950 overflow-hidden"
      style={{ height: "70vh", minHeight: 480 }}
      onClick={(e) => { if (e.target === wrapperRef.current) setSelected(null); }}
    >
      <div className="absolute top-3 left-3 z-10 text-[11px] text-slate-400 space-y-1.5 bg-slate-900/70 backdrop-blur px-2.5 py-2 rounded border border-slate-800 w-64">
        <div className="relative">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter types by name…"
            className="w-full pl-7 pr-6 py-1 text-[11px] rounded bg-slate-800/80 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              title="Clear filter"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-[10px]"
            >
              ✕
            </button>
          )}
        </div>
        {filter && (
          <label className="flex items-center gap-2 cursor-pointer select-none hover:text-slate-200 text-slate-500 text-[10px]">
            <input type="checkbox" checked={includeNeighbors} onChange={(e) => setIncludeNeighbors(e.target.checked)} className="accent-sky-500" />
            Include direct neighbors
          </label>
        )}
        <div className="space-y-1 pt-1 border-t border-slate-800">
          <CategoryToggle color="bg-white"       label="Core (user, role, group, …)" active={showCore}     onToggle={() => setShowCore((v) => !v)} />
          <CategoryToggle color="bg-slate-300"   label="Identity / project types"     active={showIdentity} onToggle={() => setShowIdentity((v) => !v)} />
          <CategoryToggle color="bg-violet-400"  label="Custom / *nik* types"         active={showCustom}   onToggle={() => setShowCustom((v) => !v)} />
        </div>
        <div className="pt-1 border-t border-slate-800">
          <label className="flex items-center gap-2 cursor-pointer select-none hover:text-slate-200">
            <input type="checkbox" checked={hideReverse} onChange={(e) => setHideReverse(e.target.checked)} className="accent-sky-500" />
            Hide reverse relationships
          </label>
        </div>
        <div className="flex items-center gap-2 pt-1 border-t border-slate-800 pointer-events-none text-slate-500">
          <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Selected
        </div>
      </div>
      <div className="absolute top-3 right-3 z-10 text-[11px] text-slate-400 bg-slate-900/70 backdrop-blur px-2.5 py-1.5 rounded border border-slate-800">
        {data.nodes.length} types · {data.links.length} relationships
      </div>

      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={dims.width}
        height={dims.height}
        backgroundColor="#020617"
        nodeRelSize={4}
        nodeVal={(n) => 2 + (n as GNode).degree}
        linkColor={(l) => {
          const s = typeof l.source === "string" ? l.source : (l.source as GNode).id;
          const t = typeof l.target === "string" ? l.target : (l.target as GNode).id;
          if (connected.size > 0 && !(connected.has(s) && connected.has(t))) return "rgba(100, 116, 139, 0.08)";
          return (l as GLink).isReverse ? "rgba(167, 139, 250, 0.22)" : "rgba(148, 163, 184, 0.35)";
        }}
        linkWidth={(l) => {
          const s = typeof l.source === "string" ? l.source : (l.source as GNode).id;
          const t = typeof l.target === "string" ? l.target : (l.target as GNode).id;
          return connected.has(s) && connected.has(t) ? 1.6 : 0.8;
        }}
        linkDirectionalArrowLength={(l) => ((l as GLink).isReverse ? 0 : 4)}
        linkDirectionalArrowRelPos={0.85}
        linkCurvature={0.12}
        linkLabel={(l) => (l as GLink).field}
        onNodeHover={(n) => setHovered(n ? (n as GNode).id : null)}
        onNodeClick={(n) => setSelected((prev) => prev === (n as GNode).id ? null : (n as GNode).id)}
        onBackgroundClick={() => setSelected(null)}
        nodeCanvasObjectMode={() => "after"}
        nodeCanvasObject={(raw, ctx, globalScale) => {
          const n = raw as GNode;
          if (n.x == null || n.y == null) return;
          const r = nodeRadius(n);
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.fillStyle = nodeColor(n, hovered, selected, connected);
          ctx.fill();

          const show =
            alwaysLabelled.has(n.id) ||
            hovered === n.id ||
            selected === n.id ||
            (connected.size > 0 && connected.has(n.id));
          if (!show) return;

          const fontSize = Math.max(10, 12 / globalScale);
          ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
          ctx.fillStyle = n.category === "custom" ? "#ddd6fe" : "#e2e8f0";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(n.name, n.x, n.y + r + 2);
        }}
        cooldownTicks={220}
        enableNodeDrag
      />
    </div>
  );
}

function CategoryToggle({
  color,
  label,
  active,
  onToggle,
}: {
  color: string;
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={[
        "flex items-center gap-2 w-full text-left transition-colors hover:text-slate-200",
        active ? "text-slate-400" : "text-slate-600",
      ].join(" ")}
      aria-pressed={active}
      title={active ? `Hide ${label}` : `Show ${label}`}
    >
      <span className={[
        "w-2 h-2 rounded-full inline-block transition-opacity",
        color,
        active ? "opacity-100" : "opacity-30",
      ].join(" ")} />
      <span className={active ? "" : "line-through"}>{label}</span>
    </button>
  );
}
