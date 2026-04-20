"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ForceGraphMethods } from "react-force-graph-2d";
import type { JourneyInfo, ScriptUsage } from "@/app/api/analyze/route";

// Force-graph uses canvas + DOM measurements — skip SSR.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type NodeKind = "journey" | "script";

interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  /** Degree — used for sizing + "important" label visibility. */
  degree: number;
  /** Root journey = no callers. */
  isRoot?: boolean;
  /** Not enabled / not wired anywhere — dimmed. */
  isDim?: boolean;
  // react-force-graph mutates these during simulation
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

interface GraphLink {
  source: string;
  target: string;
  kind: "sub-journey" | "script";
}

/**
 * Build a force-graph dataset from the analyze result.
 *  • Journey nodes + subJourney edges form the primary skeleton.
 *  • Script nodes + "uses-script" edges are secondary, rendered green.
 *  • Node size scales with degree; roots and top-degree nodes get labels.
 */
function buildGraphData(journeys: JourneyInfo[], scripts: ScriptUsage[]): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const journeyById = new Map<string, JourneyInfo>();
  for (const j of journeys) journeyById.set(j.name, j);

  for (const j of journeys) {
    const degree = j.subJourneys.length + j.calledBy.length;
    const isRoot = j.calledBy.length === 0 && !j.innerTreeOnly;
    const isDim = !j.enabled && j.calledBy.length === 0;
    nodes.push({
      id: `journey:${j.name}`,
      name: j.name,
      kind: "journey",
      degree,
      isRoot,
      isDim,
    });
  }

  for (const j of journeys) {
    for (const sub of j.subJourneys) {
      if (!journeyById.has(sub)) continue;
      links.push({ source: `journey:${j.name}`, target: `journey:${sub}`, kind: "sub-journey" });
    }
  }

  for (const s of scripts) {
    if (s.usedBy.length === 0) continue;
    nodes.push({
      id: `script:${s.uuid}`,
      name: s.name || s.uuid,
      kind: "script",
      degree: s.usedBy.length,
    });
    for (const u of s.usedBy) {
      if (!journeyById.has(u.journey)) continue;
      links.push({ source: `journey:${u.journey}`, target: `script:${s.uuid}`, kind: "script" });
    }
  }

  return { nodes, links };
}

function nodeRadius(node: GraphNode): number {
  return node.kind === "journey"
    ? 3 + Math.min(12, Math.sqrt(node.degree) * 2.2)
    : 2.5 + Math.min(6, Math.sqrt(node.degree) * 1.5);
}

function nodeColor(node: GraphNode, hovered: string | null, selected: string | null, connected: Set<string>): string {
  if (selected === node.id) return "#facc15"; // amber-400
  if (hovered === node.id) return "#7dd3fc";  // sky-300
  if (connected.size > 0 && !connected.has(node.id)) return "#1f2937"; // dimmed slate-800
  if (node.kind === "script") return "#34d399";            // emerald-400
  if (node.isRoot)            return "#ffffff";
  if (node.isDim)             return "#475569";            // slate-600
  return "#cbd5e1";                                        // slate-300
}

interface Props {
  journeys: JourneyInfo[];
  scripts: ScriptUsage[];
}

/**
 * Obsidian-style force-directed map of the journeys + scripts graph.
 * Labels render for root journeys and the top-N most-connected nodes;
 * hovering or clicking a node highlights its neighbors and draws the
 * label for anyone in the neighborhood.
 */
export function JourneyForceGraph({ journeys, scripts }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Per-category visibility toggles (click the legend dot to flip).
  const [showRoots, setShowRoots] = useState(true);
  const [showJourneys, setShowJourneys] = useState(true);
  const [showScripts, setShowScripts] = useState(true);

  const fullData = useMemo(() => buildGraphData(journeys, scripts), [journeys, scripts]);

  // Apply the category filters. Dropping a node also drops any link that
  // would be dangling so ForceGraph2D doesn't create stray stub nodes.
  const data = useMemo(() => {
    const visible = (n: GraphNode) => {
      if (n.kind === "script") return showScripts;
      if (n.isRoot)             return showRoots;
      return showJourneys;
    };
    const keptNodes = fullData.nodes.filter(visible);
    const keptIds = new Set(keptNodes.map((n) => n.id));
    const keptLinks = fullData.links.filter((l) => {
      const src = typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
      const tgt = typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
      return keptIds.has(src) && keptIds.has(tgt);
    });
    return { nodes: keptNodes, links: keptLinks };
  }, [fullData, showRoots, showJourneys, showScripts]);

  // Precompute adjacency for neighborhood highlighting.
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const l of data.links) {
      const src = typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
      const tgt = typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
      if (!map.has(src)) map.set(src, new Set());
      if (!map.has(tgt)) map.set(tgt, new Set());
      map.get(src)!.add(tgt);
      map.get(tgt)!.add(src);
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

  // Nodes that always show their label: roots, top-N most-connected.
  const alwaysLabelled = useMemo(() => {
    const s = new Set<string>();
    for (const n of data.nodes) if (n.isRoot) s.add(n.id);
    const top = [...data.nodes].sort((a, b) => b.degree - a.degree).slice(0, 6);
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

  // Nudge the simulation gently on mount so a giant cluster settles before
  // the user interacts. ForceGraph2D's default charge/link strengths are
  // tuned for small-to-medium graphs; this just runs a few extra ticks.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3ReheatSimulation();
  }, [data]);

  return (
    <div
      ref={wrapperRef}
      className="relative rounded-lg border border-slate-800 bg-slate-950 overflow-hidden"
      style={{ height: "70vh", minHeight: 480 }}
      onClick={(e) => {
        if (e.target === wrapperRef.current) setSelected(null);
      }}
    >
      <div className="absolute top-3 left-3 z-10 text-[11px] text-slate-400 space-y-1 bg-slate-900/70 backdrop-blur px-2.5 py-1.5 rounded border border-slate-800">
        <CategoryToggle color="bg-white"        label="Root journey" active={showRoots}    onToggle={() => setShowRoots((v) => !v)} />
        <CategoryToggle color="bg-slate-300"    label="Journey"      active={showJourneys} onToggle={() => setShowJourneys((v) => !v)} />
        <CategoryToggle color="bg-emerald-400"  label="Script"       active={showScripts}  onToggle={() => setShowScripts((v) => !v)} />
        <div className="flex items-center gap-2 pt-1 mt-1 border-t border-slate-800 pointer-events-none text-slate-500">
          <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Selected
        </div>
      </div>
      <div className="absolute top-3 right-3 z-10 text-[11px] text-slate-400 bg-slate-900/70 backdrop-blur px-2.5 py-1.5 rounded border border-slate-800">
        {data.nodes.length} nodes · {data.links.length} links
      </div>

      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={dims.width}
        height={dims.height}
        backgroundColor="#020617"
        nodeRelSize={4}
        nodeVal={(n) => (n as GraphNode).kind === "journey" ? 2 + (n as GraphNode).degree : 0.8}
        linkColor={(l) => {
          const src = typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
          const tgt = typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
          const hit = connected.has(src) && connected.has(tgt);
          if (connected.size > 0 && !hit) return "rgba(100, 116, 139, 0.08)"; // dimmed
          return (l as GraphLink).kind === "script"
            ? "rgba(52, 211, 153, 0.35)"
            : "rgba(148, 163, 184, 0.35)";
        }}
        linkWidth={(l) => {
          const src = typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
          const tgt = typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
          return connected.has(src) && connected.has(tgt) ? 1.6 : 0.8;
        }}
        onNodeHover={(n) => setHovered(n ? (n as GraphNode).id : null)}
        onNodeClick={(n) => setSelected((prev) => prev === (n as GraphNode).id ? null : (n as GraphNode).id)}
        onBackgroundClick={() => setSelected(null)}
        nodeCanvasObjectMode={() => "after"}
        nodeCanvasObject={(rawNode, ctx, globalScale) => {
          const node = rawNode as GraphNode;
          if (node.x == null || node.y == null) return;

          // Dot
          const r = nodeRadius(node);
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
          ctx.fillStyle = nodeColor(node, hovered, selected, connected);
          ctx.fill();

          // Label: always for roots / top-N, or when node is in the focused neighborhood.
          const showLabel =
            alwaysLabelled.has(node.id) ||
            hovered === node.id ||
            selected === node.id ||
            (connected.size > 0 && connected.has(node.id));
          if (!showLabel) return;

          const fontSize = Math.max(10, 12 / globalScale);
          ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
          ctx.fillStyle = node.kind === "script" ? "#86efac" : "#e2e8f0";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(node.name, node.x, node.y + r + 2);
        }}
        cooldownTicks={180}
        enableNodeDrag
      />
    </div>
  );
}

/** Legend dot + label as a toggle button. Dimmed when hidden. */
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
