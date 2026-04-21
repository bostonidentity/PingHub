"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  useNodesState,
  SelectionMode,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { cn } from "@/lib/utils";
import type { ManagedObjectType, ManagedObjectRelationship } from "@/app/api/analyze/managed-objects/route";

// ── Node layout / styling ────────────────────────────────────────────────────

const NODE_W = 220;
const NODE_H = 40;

type Category = "core" | "identity" | "custom";

function categorize(name: string): Category {
  const lower = name.toLowerCase();
  if (lower.includes("custom") || lower.includes("nik")) return "custom";
  const core = ["user", "role", "group", "organization", "assignment", "application"];
  for (const c of core) if (lower.endsWith(c) || lower.endsWith(`_${c}`) || lower === c) return "core";
  return "identity";
}

const CATEGORY_DOT: Record<Category, string> = {
  core:     "bg-white",
  identity: "bg-slate-300",
  custom:   "bg-violet-400",
};

function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR",
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 24, ranksep: 70 });
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    if (!p) return n;
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}

// ── Custom node ──────────────────────────────────────────────────────────────

function ManagedObjectNode({ data, selected }: NodeProps) {
  const d = data as {
    name: string;
    category: Category;
    isFocused: boolean;
    incomingCount: number;
    outgoingCount: number;
  };
  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2 flex items-center gap-2 border bg-slate-900/95 backdrop-blur transition-colors overflow-hidden",
        selected
          ? "border-sky-500 ring-2 ring-sky-400/40"
          : d.isFocused
            ? "border-amber-400 ring-1 ring-amber-400/40"
            : "border-slate-700 hover:border-slate-500",
      )}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#475569" }} />
      <span className={cn("w-2 h-2 rounded-full shrink-0", CATEGORY_DOT[d.category])} />
      <span className="text-[12px] text-slate-100 truncate flex-1" title={d.name}>{d.name}</span>
      <span className="text-[9px] text-slate-500 font-mono tabular-nums shrink-0" title={`${d.incomingCount} incoming / ${d.outgoingCount} outgoing`}>
        {d.incomingCount}↓{d.outgoingCount}↑
      </span>
      <Handle type="source" position={Position.Right} style={{ background: "#475569" }} />
    </div>
  );
}

const nodeTypes = { managedObject: ManagedObjectNode };

// ── Inner component (needs ReactFlowProvider context) ───────────────────────

interface Props {
  types: ManagedObjectType[];
  relationships: ManagedObjectRelationship[];
}

function ManagedObjectsGraphInner({ types, relationships }: Props) {
  const { fitView } = useReactFlow();

  const [filter, setFilter] = useState("");
  const [includeNeighbors, setIncludeNeighbors] = useState(true);
  const [showCore, setShowCore] = useState(true);
  const [showIdentity, setShowIdentity] = useState(true);
  const [showCustom, setShowCustom] = useState(true);
  const [hideReverse, setHideReverse] = useState(true);
  const [direction, setDirection] = useState<"LR" | "TB">("LR");

  // Pre-compute adjacency on the full graph for the "include neighbors" filter.
  const fullAdj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of relationships) {
      if (!m.has(r.source)) m.set(r.source, new Set());
      if (!m.has(r.target)) m.set(r.target, new Set());
      m.get(r.source)!.add(r.target);
      m.get(r.target)!.add(r.source);
    }
    return m;
  }, [relationships]);

  // Node / edge filtering + dagre layout run together. Every change to a
  // filter redoes the layout so spacing stays honest.
  const { layoutedNodes, layoutedEdges } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const keepByCategory = (cat: Category) =>
      cat === "core" ? showCore : cat === "custom" ? showCustom : showIdentity;

    // Stage 1: filter set from the name query.
    const nameHits = new Set<string>();
    if (q) {
      for (const t of types) if (t.name.toLowerCase().includes(q)) nameHits.add(t.name);
      if (includeNeighbors) {
        for (const id of [...nameHits]) {
          for (const nb of fullAdj.get(id) ?? []) nameHits.add(nb);
        }
      }
    }

    const visibleNodes: Node[] = [];
    const visibleNodeIds = new Set<string>();
    for (const t of types) {
      const cat = categorize(t.name);
      if (!keepByCategory(cat)) continue;
      if (q && !nameHits.has(t.name)) continue;
      visibleNodeIds.add(t.name);
      visibleNodes.push({
        id: t.name,
        type: "managedObject",
        position: { x: 0, y: 0 },
        data: {
          name: t.name,
          category: cat,
          isFocused: q ? nameHits.has(t.name) : false,
          incomingCount: t.incomingCount,
          outgoingCount: t.outgoingCount,
        },
      });
    }

    const visibleEdges: Edge[] = [];
    for (const r of relationships) {
      if (hideReverse && r.isReverse) continue;
      if (!visibleNodeIds.has(r.source) || !visibleNodeIds.has(r.target)) continue;
      visibleEdges.push({
        id: `${r.source}→${r.target}::${r.field}`,
        source: r.source,
        target: r.target,
        label: r.field,
        labelStyle: { fill: "#94a3b8", fontSize: 10 },
        labelBgStyle: { fill: "#020617" },
        labelBgPadding: [4, 2],
        type: "default",
        animated: false,
        style: {
          stroke: r.isReverse ? "rgba(167, 139, 250, 0.55)" : "rgba(148, 163, 184, 0.6)",
          strokeWidth: 1.25,
        },
      });
    }

    const laidOut = applyDagreLayout(visibleNodes, visibleEdges, direction);
    return { layoutedNodes: laidOut, layoutedEdges: visibleEdges };
  }, [types, relationships, filter, includeNeighbors, showCore, showIdentity, showCustom, hideReverse, fullAdj, direction]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(layoutedNodes);

  // Push the latest layouted positions into the rf state whenever filters
  // change; keep the draggable-position edits the user has made intact
  // *within* a given filter (useNodesState preserves identity-based edits
  // but we reset on filter change so they're not left orphaned).
  useEffect(() => {
    setRfNodes(layoutedNodes);
    // Fit after a tick so dagre positions are already committed.
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
  }, [layoutedNodes, setRfNodes, fitView]);

  return (
    <div className="relative rounded-lg border border-slate-800 bg-slate-950 overflow-hidden" style={{ height: "70vh", minHeight: 480 }}>
      {/* Controls overlay */}
      <div className="absolute top-3 left-3 z-10 text-[11px] text-slate-400 space-y-1.5 bg-slate-900/80 backdrop-blur px-2.5 py-2 rounded border border-slate-800 w-64">
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
            >✕</button>
          )}
        </div>
        {filter && (
          <label className="flex items-center gap-2 cursor-pointer select-none hover:text-slate-200 text-slate-500 text-[10px]">
            <input type="checkbox" checked={includeNeighbors} onChange={(e) => setIncludeNeighbors(e.target.checked)} className="accent-sky-500" />
            Include direct neighbors
          </label>
        )}
        <div className="space-y-1 pt-1 border-t border-slate-800">
          <CategoryToggle color="bg-white"      label="Core (user, role, group, …)" active={showCore}     onToggle={() => setShowCore((v) => !v)} />
          <CategoryToggle color="bg-slate-300"  label="Identity / project types"     active={showIdentity} onToggle={() => setShowIdentity((v) => !v)} />
          <CategoryToggle color="bg-violet-400" label="Custom / *nik* types"         active={showCustom}   onToggle={() => setShowCustom((v) => !v)} />
        </div>
        <div className="pt-1 border-t border-slate-800 space-y-1">
          <label className="flex items-center gap-2 cursor-pointer select-none hover:text-slate-200">
            <input type="checkbox" checked={hideReverse} onChange={(e) => setHideReverse(e.target.checked)} className="accent-sky-500" />
            Hide reverse relationships
          </label>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Layout:</span>
            <button
              type="button"
              onClick={() => setDirection("LR")}
              className={cn("px-2 py-0.5 rounded border transition-colors", direction === "LR" ? "bg-sky-600 text-white border-sky-600" : "border-slate-700 text-slate-400 hover:border-slate-500")}
            >Left → Right</button>
            <button
              type="button"
              onClick={() => setDirection("TB")}
              className={cn("px-2 py-0.5 rounded border transition-colors", direction === "TB" ? "bg-sky-600 text-white border-sky-600" : "border-slate-700 text-slate-400 hover:border-slate-500")}
            >Top → Bottom</button>
          </div>
        </div>
      </div>
      <div className="absolute top-3 right-3 z-10 text-[11px] text-slate-400 bg-slate-900/80 backdrop-blur px-2.5 py-1.5 rounded border border-slate-800">
        {layoutedNodes.length} types · {layoutedEdges.length} relationships
      </div>

      <ReactFlow
        nodes={rfNodes}
        edges={layoutedEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        nodesDraggable
        snapToGrid
        snapGrid={[10, 10]}
        selectionOnDrag
        selectionMode={SelectionMode.Full}
        panOnDrag={[1, 2]}
        proOptions={{ hideAttribution: true }}
        style={{ backgroundColor: "#020617" }}
      >
        <Background color="#1e293b" gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          style={{ backgroundColor: "#020617" }}
          maskColor="rgba(2, 6, 23, 0.6)"
          nodeColor={(n) => {
            const cat = (n.data as { category?: Category })?.category ?? "identity";
            return cat === "core" ? "#ffffff" : cat === "custom" ? "#a78bfa" : "#cbd5e1";
          }}
        />
      </ReactFlow>
    </div>
  );
}

// ── Provider wrapper + small helpers ─────────────────────────────────────────

export function ManagedObjectsGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <ManagedObjectsGraphInner {...props} />
    </ReactFlowProvider>
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
      className={cn(
        "flex items-center gap-2 w-full text-left transition-colors hover:text-slate-200",
        active ? "text-slate-400" : "text-slate-600",
      )}
      aria-pressed={active}
      title={active ? `Hide ${label}` : `Show ${label}`}
    >
      <span className={cn("w-2 h-2 rounded-full inline-block transition-opacity", color, active ? "opacity-100" : "opacity-30")} />
      <span className={active ? "" : "line-through"}>{label}</span>
    </button>
  );
}
