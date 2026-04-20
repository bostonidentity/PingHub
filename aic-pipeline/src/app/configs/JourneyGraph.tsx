"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  Panel,
  Handle,
  Position,
  useReactFlow,
  useNodesState,
  type Node,
  type Edge,
  type NodeProps,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import ELK from "elkjs/lib/elk.bundled.js";
import { cn } from "@/lib/utils";
import { highlightJs, ScriptOverlay } from "./ScriptOverlay";
import { withLineNumbers } from "@/lib/highlight";
import { JourneyOutlineView  } from "./JourneyOutlineView";
import { JourneyTableView    } from "./JourneyTableView";
import { JourneySwimLaneView } from "./JourneySwimLaneView";
import { JourneyLegendModal } from "@/components/JourneyLegendModal";

// ── Constants ─────────────────────────────────────────────────────────────────

const SUCCESS_ID = "e301438c-0bd0-429c-ab0c-66126501069a";
const FAILURE_ID = "70e691a5-1e33-4ac3-a356-e7b6d60d92e0";
const NODE_W     = 175;
const NODE_H     = 64;
const TERM_SIZE  = 60;
const START_SIZE = 48;

// Page group
const PAGE_GROUP_W   = 199;
const PAGE_CHILD_W   = 175; // PAGE_GROUP_W - 24
const PAGE_CHILD_H   = 30;
const PAGE_GROUP_TOP = 42;  // header height
const PAGE_GROUP_PAD = 12;
const PAGE_CHILD_GAP = 6;

// Collapsed passthrough-chain pill (replaces a linear run of single-in / single-out nodes)
const CHAIN_W = 170;
const CHAIN_H = 48;
const CHAIN_MIN_LEN = 3; // minimum run length that will be collapsed

function journeyNodeHeight(outcomeCount: number): number {
  return Math.max(NODE_H, outcomeCount * 22 + 28);
}

function pageGroupHeight(childCount: number): number {
  return PAGE_GROUP_TOP
    + childCount * PAGE_CHILD_H
    + Math.max(0, childCount - 1) * PAGE_CHILD_GAP
    + PAGE_GROUP_PAD;
}

function getNodeDims(node: Node): [number, number] {
  if (node.type === "journeyNode") {
    const outcomes = (node.data.outcomes as string[] | undefined) ?? [];
    return [NODE_W, journeyNodeHeight(outcomes.length)];
  }
  if (node.type === "pageGroup") {
    const children = (node.data.children as PageChildConfig[] | undefined) ?? [];
    return [PAGE_GROUP_W, pageGroupHeight(children.length)];
  }
  if (node.type === "startNode")     return [START_SIZE, START_SIZE];
  if (node.type === "successNode")   return [TERM_SIZE,  TERM_SIZE];
  if (node.type === "failureNode")   return [TERM_SIZE,  TERM_SIZE];
  if (node.type === "chainCollapsed") return [CHAIN_W,    CHAIN_H];
  return [NODE_W, NODE_H];
}

// ── Journey JSON ──────────────────────────────────────────────────────────────

interface JourneyJson {
  _id?: string;
  entryNodeId?: string;
  nodes?: Record<string, {
    displayName?: string;
    nodeType?: string;
    connections?: Record<string, string>;
    x: number;
    y: number;
  }>;
  staticNodes?: Record<string, { x: number; y: number }>;
}

interface PageChildConfig {
  _id: string;
  displayName: string;
  nodeType: string;
}

interface PageNodeConfig {
  nodes?: PageChildConfig[];
}

// ── Custom nodes ──────────────────────────────────────────────────────────────

const SPECIAL_NODE_BG: Partial<Record<string, string>> = {
  ScriptedDecisionNode:   "bg-violet-50",
  InnerTreeEvaluatorNode: "bg-amber-50",
};


function JourneyNodeComponent({ data }: NodeProps) {
  const d = data as {
    label: string;
    nodeType?: string;
    outcomes: string[];
    isSelected?: boolean;
    isSearchMatch?: boolean;
    isFlashing?: boolean;
  };
  const outcomes = d.outcomes ?? [];
  const h        = journeyNodeHeight(outcomes.length);
  const specialBg = d.nodeType ? (SPECIAL_NODE_BG[d.nodeType] ?? "bg-white") : "bg-white";

  return (
    <div
      className={cn(
        "border rounded-lg shadow-sm transition-all overflow-visible cursor-pointer active:cursor-grabbing",
        specialBg,
        d.isFlashing    ? "border-sky-400 ring-4 ring-sky-300 ring-opacity-100 animate-pulse" :
        d.isSelected    ? "border-sky-500 ring-2 ring-sky-300 shadow-sky-100" :
        d.isSearchMatch ? "border-amber-400 ring-2 ring-amber-200" :
                          "border-slate-300"
      )}
      style={{ width: NODE_W, height: h, position: "relative" }}
    >
      <Handle type="target" position={Position.Left} style={{ top: "50%", background: "#94a3b8" }} />

      <div className="px-3 pt-2" style={{ paddingRight: outcomes.length > 0 ? 56 : 12 }}>
        <p className="text-[11px] font-medium text-slate-700 leading-snug break-words">{d.label}</p>
        {d.nodeType && <p className="text-[9px] text-slate-400 mt-0.5 truncate">{d.nodeType}</p>}
      </div>

      {outcomes.length > 0
        ? outcomes.map((outcome, i) => {
            const topPct = `${((i + 0.5) / outcomes.length) * 100}%`;
            return (
              <Fragment key={outcome}>
                <span style={{
                  position: "absolute", right: 14, top: topPct,
                  transform: "translateY(-50%)", fontSize: 8, color: "#94a3b8",
                  fontFamily: "monospace", whiteSpace: "nowrap",
                  maxWidth: 48, overflow: "hidden", textOverflow: "ellipsis",
                  pointerEvents: "none",
                }}>
                  {outcome}
                </span>
                <Handle id={outcome} type="source" position={Position.Right}
                  style={{ top: topPct, background: "#94a3b8" }} />
              </Fragment>
            );
          })
        : <Handle type="source" position={Position.Right} style={{ top: "50%", background: "#94a3b8" }} />
      }
    </div>
  );
}

function PageGroupNodeComponent({ data }: NodeProps) {
  const d = data as {
    label: string;
    children: PageChildConfig[];
    outcomes?: string[];
    isSelected?: boolean;
    isSearchMatch?: boolean;
  };
  const outcomes = d.outcomes ?? [];
  const h = pageGroupHeight(d.children.length);

  return (
    <div
      className={cn(
        "border-2 rounded-xl transition-all cursor-pointer active:cursor-grabbing",
        d.isSelected    ? "border-violet-500 bg-violet-50 ring-2 ring-violet-300" :
        d.isSearchMatch ? "border-amber-400  bg-amber-50  ring-2 ring-amber-200" :
                          "border-violet-300 bg-violet-50/60"
      )}
      style={{ width: PAGE_GROUP_W, height: h, position: "relative" }}
    >
      <Handle type="target" position={Position.Left} style={{ top: "50%", background: "#94a3b8" }} />

      {/* Header */}
      <div className="px-3 pt-2 pb-1 border-b border-violet-200/80">
        <p className="text-[9px] font-semibold text-violet-500 uppercase tracking-wider">Page Node</p>
        <p className="text-[11px] font-medium text-slate-700 leading-tight truncate">{d.label}</p>
      </div>

      {outcomes.length > 0
        ? outcomes.map((outcome, i) => {
            const topPct = `${((i + 0.5) / outcomes.length) * 100}%`;
            return (
              <Handle key={outcome} id={outcome} type="source" position={Position.Right}
                style={{ top: topPct, background: "#94a3b8" }} />
            );
          })
        : <Handle type="source" position={Position.Right} style={{ top: "50%", background: "#94a3b8" }} />
      }
    </div>
  );
}

function PageChildNodeComponent({ data }: NodeProps) {
  const d = data as { label: string; nodeType: string; isSearchMatch?: boolean };
  return (
    <div
      className={cn(
        "bg-white border rounded-md shadow-sm px-2 flex flex-col justify-center",
        d.isSearchMatch ? "border-amber-400 ring-1 ring-amber-300" : "border-violet-200",
      )}
      style={{ width: PAGE_CHILD_W, height: PAGE_CHILD_H }}
    >
      <p className="text-[10px] font-medium text-slate-700 leading-tight truncate">{d.label}</p>
      <p className="text-[9px] text-violet-400 truncate">{d.nodeType}</p>
    </div>
  );
}

function StartNodeComponent(_: NodeProps) {
  return (
    <div className="rounded-full flex items-center justify-center shadow font-bold text-white text-[9px] bg-emerald-500 cursor-pointer active:cursor-grabbing"
      style={{ width: START_SIZE, height: START_SIZE }}>
      <Handle type="source" position={Position.Right} style={{ background: "#059669" }} />
      START
    </div>
  );
}

function SuccessNodeComponent({ data }: NodeProps) {
  const d = data as { isSelected?: boolean };
  return (
    <div className={cn(
      "rounded-full border-2 flex items-center justify-center shadow-sm font-bold text-emerald-700 text-[10px] text-center leading-tight cursor-pointer active:cursor-grabbing",
      d.isSelected ? "bg-emerald-100 border-emerald-500 ring-2 ring-emerald-200" : "bg-emerald-50 border-emerald-400"
    )} style={{ width: TERM_SIZE, height: TERM_SIZE }}>
      <Handle type="target" position={Position.Left} style={{ background: "#34d399" }} />
      ✓<br />OK
    </div>
  );
}

function FailureNodeComponent({ data }: NodeProps) {
  const d = data as { isSelected?: boolean };
  return (
    <div className={cn(
      "rounded-full border-2 flex items-center justify-center shadow-sm font-bold text-red-700 text-[10px] text-center leading-tight cursor-pointer active:cursor-grabbing",
      d.isSelected ? "bg-red-100 border-red-500 ring-2 ring-red-200" : "bg-red-50 border-red-400"
    )} style={{ width: TERM_SIZE, height: TERM_SIZE }}>
      <Handle type="target" position={Position.Left} style={{ background: "#f87171" }} />
      ✗<br />Fail
    </div>
  );
}

function ChainCollapsedNodeComponent({ data }: NodeProps) {
  const d = data as { count: number; typesSummary: string; isSelected?: boolean };
  return (
    <div
      className={cn(
        "border border-dashed rounded-lg shadow-sm bg-slate-50 transition-all cursor-pointer active:cursor-grabbing",
        d.isSelected ? "border-sky-500 ring-2 ring-sky-300" : "border-slate-300 hover:border-slate-400"
      )}
      style={{ width: CHAIN_W, height: CHAIN_H, position: "relative" }}
      title="Click to expand chain"
    >
      <Handle type="target" position={Position.Left} style={{ top: "50%", background: "#94a3b8" }} />
      <div className="px-3 py-1 flex flex-col justify-center h-full">
        <p className="text-[11px] font-medium text-slate-700 leading-tight">⋯ {d.count} steps</p>
        <p className="text-[9px] text-slate-400 truncate">{d.typesSummary}</p>
      </div>
      <Handle type="source" position={Position.Right} style={{ top: "50%", background: "#94a3b8" }} />
    </div>
  );
}

const nodeTypes = {
  journeyNode:    JourneyNodeComponent,
  pageGroup:      PageGroupNodeComponent,
  pageChild:      PageChildNodeComponent,
  startNode:      StartNodeComponent,
  successNode:    SuccessNodeComponent,
  failureNode:    FailureNodeComponent,
  chainCollapsed: ChainCollapsedNodeComponent,
};

// ── Parser ────────────────────────────────────────────────────────────────────

function parseJourney(json: string, pageConfigs?: Map<string, PageNodeConfig>): { nodes: Node[]; edges: Edge[] } {
  let data: JourneyJson;
  try { data = JSON.parse(json); } catch { return { nodes: [], edges: [] }; }

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  for (const [id, pos] of Object.entries(data.staticNodes ?? {})) {
    const type =
      id === "startNode" ? "startNode"   :
      id === SUCCESS_ID  ? "successNode" :
      id === FAILURE_ID  ? "failureNode" : "successNode";
    rfNodes.push({ id, type, position: { x: pos.x, y: pos.y },
      data: { label: id === "startNode" ? "Start" : id === SUCCESS_ID ? "Success" : id === FAILURE_ID ? "Failure" : "End", outcomes: [] } });
  }

  if (data.entryNodeId && data.staticNodes?.["startNode"]) {
    rfEdges.push({ id: "__start__", source: "startNode", target: data.entryNodeId,
      style: { stroke: "#10b981", strokeWidth: 2 } });
  }

  for (const [id, node] of Object.entries(data.nodes ?? {})) {
    const isPageNode  = node.nodeType === "PageNode";
    const pageConfig  = isPageNode ? pageConfigs?.get(id) : undefined;

    if (isPageNode && pageConfig) {
      const children = pageConfig.nodes ?? [];
      const groupH   = pageGroupHeight(children.length);

      // Group container node
      rfNodes.push({
        id,
        type: "pageGroup",
        position: { x: 0, y: 0 },
        style: { width: PAGE_GROUP_W, height: groupH },
        data: {
          label: node.displayName ?? "Page Node",
          nodeType: "PageNode",
          children,
          outcomes: Object.keys(node.connections ?? {}),
        },
      });

      // Child nodes (positioned relative to parent group)
      children.forEach((child, i) => {
        rfNodes.push({
          id: `${id}__child__${child._id}`,
          type: "pageChild",
          position: { x: PAGE_GROUP_PAD, y: PAGE_GROUP_TOP + i * (PAGE_CHILD_H + PAGE_CHILD_GAP) },
          parentId: id,
          extent: "parent" as const,
          draggable: false,
          selectable: false,
          focusable: false,
          style: { width: PAGE_CHILD_W, height: PAGE_CHILD_H },
          data: { label: child.displayName, nodeType: child.nodeType },
        });
      });
    } else {
      const outcomes = Object.keys(node.connections ?? {});
      rfNodes.push({ id, type: "journeyNode", position: { x: 0, y: 0 },
        data: { label: node.displayName ?? node.nodeType ?? id.slice(0, 8), nodeType: node.nodeType, outcomes } });
    }

    // Edges (same for both regular and page group nodes)
    Object.entries(node.connections ?? {}).forEach(([outcomeId, targetId]) => {
      const toSuccess = targetId === SUCCESS_ID;
      const toFailure = targetId === FAILURE_ID;
      rfEdges.push({
        id: `${id}--${outcomeId}`,
        source: id, sourceHandle: outcomeId,
        target: targetId,
        label: outcomeId === "outcome" ? undefined : outcomeId,
        style: { stroke: toFailure ? "#f87171" : toSuccess ? "#34d399" : "#64748b", strokeWidth: 1.5 },
        labelStyle: { fontSize: 9, fill: "#64748b" },
        labelBgStyle: { fill: "#f8fafc", fillOpacity: 0.9 },
        labelBgPadding: [3, 5] as [number, number],
        labelBgBorderRadius: 3,
      });
    });
  }

  return { nodes: rfNodes, edges: rfEdges };
}

// ── Dagre layout ──────────────────────────────────────────────────────────────

function applyDagreLayout(nodes: Node[], edges: Edge[], compact = false): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph(compact
    ? { rankdir: "LR", nodesep: 25, ranksep: 60,  marginx: 24, marginy: 24 }
    : { rankdir: "LR", nodesep: 60, ranksep: 160, marginx: 40, marginy: 40 },
  );

  // Only layout top-level nodes — children keep relative position inside group
  nodes.filter((n) => !n.parentId).forEach((n) => {
    const [w, h] = getNodeDims(n);
    g.setNode(n.id, { width: w, height: h });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  return nodes.map((n) => {
    if (n.parentId) return n; // child: keep relative position
    const pos = g.node(n.id);
    if (!pos) return n;
    const [w, h] = getNodeDims(n);
    return { ...n, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
  });
}

// ── ELK layout ───────────────────────────────────────────────────────────────

const elk = new ELK();

/**
 * Layered layout via elkjs. Same visual grammar as dagre (ranks, LR flow) but
 * with a stronger crossing minimizer and an `aspectRatio` hint so wide-shallow
 * journeys pull their branches into unused vertical space instead of sprawling
 * further right. `considerModelOrder` keeps outcome order stable across runs;
 * SPLINES routing matches dagre's smooth edges.
 */
async function applyElkLayout(nodes: Node[], edges: Edge[], compact = false): Promise<Node[]> {
  const nodesep = compact ? 25 : 60;
  const ranksep = compact ? 60 : 160;
  const topLevel = nodes.filter((n) => !n.parentId);

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "SPLINES",
      "elk.aspectRatio": "1.6",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.spacing.nodeNode": String(nodesep),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(ranksep),
    },
    children: topLevel.map((n) => {
      const [w, h] = getNodeDims(n);
      return { id: n.id, width: w, height: h };
    }),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const laid = await elk.layout(elkGraph);
  const posMap = new Map<string, { x: number; y: number }>();
  for (const c of laid.children ?? []) {
    if (c.id) posMap.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  }

  return nodes.map((n) => {
    if (n.parentId) return n;
    const p = posMap.get(n.id);
    return p ? { ...n, position: p } : n;
  });
}

// ── Passthrough-chain collapse ────────────────────────────────────────────────

/**
 * Fold linear runs of single-in/single-out journeyNodes into a single pill.
 * A chain member has: type === "journeyNode", exactly one outcome, exactly one
 * incoming edge, and no parentId. Maximal runs of ≥ `minLen` members are
 * replaced with a `chainCollapsed` pseudo-node; the boundary edges are
 * rerouted through it so upstream/downstream highlighting still works.
 * Chains whose id appears in `expandedIds` are left alone so the user can
 * drill into a specific run.
 */
function collapseChains(
  nodes: Node[],
  edges: Edge[],
  expandedIds: Set<string>,
  minLen: number,
): { nodes: Node[]; edges: Edge[]; chains: Array<{ id: string; memberIds: string[] }> } {
  const nodeMap   = new Map(nodes.map((n) => [n.id, n]));
  const inCount   = new Map<string, number>();
  const outEdgeBy = new Map<string, Edge[]>();
  const inEdgeBy  = new Map<string, Edge[]>();
  for (const e of edges) {
    inCount.set(e.target, (inCount.get(e.target) ?? 0) + 1);
    (outEdgeBy.get(e.source) ?? outEdgeBy.set(e.source, []).get(e.source)!).push(e);
    (inEdgeBy.get(e.target)  ?? inEdgeBy.set(e.target,  []).get(e.target)!).push(e);
  }

  const isChainMember = (id: string): boolean => {
    const n = nodeMap.get(id);
    if (!n || n.type !== "journeyNode" || n.parentId) return false;
    const outs = (n.data as { outcomes?: string[] }).outcomes ?? [];
    return outs.length === 1 && (inCount.get(id) ?? 0) === 1;
  };

  const visited = new Set<string>();
  const chains: Array<{ id: string; memberIds: string[]; inEdge: Edge; outEdge: Edge }> = [];

  for (const n of nodes) {
    if (visited.has(n.id) || !isChainMember(n.id)) continue;
    // Only start walks at chain-heads: predecessor exists but isn't a member.
    const predEdges = inEdgeBy.get(n.id);
    if (!predEdges || predEdges.length !== 1 || isChainMember(predEdges[0].source)) continue;

    const members: string[] = [];
    let cur = n.id;
    while (isChainMember(cur) && !visited.has(cur)) {
      members.push(cur);
      visited.add(cur);
      const outE = outEdgeBy.get(cur);
      if (!outE || outE.length !== 1) break;
      if (!isChainMember(outE[0].target)) break;
      cur = outE[0].target;
    }
    if (members.length < minLen) continue;

    chains.push({
      id: `__chain__${members[0]}`,
      memberIds: members,
      inEdge:  inEdgeBy.get(members[0])![0],
      outEdge: outEdgeBy.get(members[members.length - 1])![0],
    });
  }

  const activeChains  = chains.filter((c) => !expandedIds.has(c.id));
  const activeMembers = new Set(activeChains.flatMap((c) => c.memberIds));
  const removedEdges  = new Set<string>();
  for (const c of activeChains) {
    for (const m of c.memberIds) {
      for (const e of outEdgeBy.get(m) ?? []) removedEdges.add(e.id);
      for (const e of inEdgeBy.get(m)  ?? []) removedEdges.add(e.id);
    }
  }

  const newNodes: Node[] = nodes.filter((n) => !activeMembers.has(n.id));
  for (const c of activeChains) {
    const types = c.memberIds.map((id) => {
      const d = nodeMap.get(id)?.data as { nodeType?: string } | undefined;
      return (d?.nodeType ?? "Node").replace(/Node$/, "");
    });
    const unique = Array.from(new Set(types));
    const typesSummary = unique.slice(0, 3).join(" · ") + (unique.length > 3 ? ` +${unique.length - 3}` : "");
    newNodes.push({
      id: c.id, type: "chainCollapsed", position: { x: 0, y: 0 },
      data: { count: c.memberIds.length, typesSummary, memberIds: c.memberIds },
    });
  }

  const newEdges: Edge[] = edges.filter((e) => !removedEdges.has(e.id));
  for (const c of activeChains) {
    // Reroute: prev → chain (keep source handle / style / label), then chain → next
    // (drop source handle so ReactFlow uses the pill's default right-side handle).
    newEdges.push({ ...c.inEdge, id: `${c.inEdge.id}__to_${c.id}`, target: c.id });
    const { sourceHandle: _sh, ...rest } = c.outEdge;
    newEdges.push({ ...rest, id: `${c.id}__out_${c.outEdge.target}`, source: c.id, label: undefined });
  }

  return { nodes: newNodes, edges: newEdges, chains: chains.map((c) => ({ id: c.id, memberIds: c.memberIds })) };
}

// ── Path tracing ──────────────────────────────────────────────────────────────

/**
 * Trace-path highlight set: every node on at least one complete
 * start → clicked → terminal path. Nodes that can reach `nodeId` but aren't
 * reachable from a source (orphans above), and nodes `nodeId` can reach but
 * which never terminate (orphans below), are excluded. Returns the usual
 * `{ ancestors, descendants }` shape so existing render code can stay.
 *
 * Sources: nodes with no incoming edges. Sinks: nodes with no outgoing edges.
 * In ForgeRock auth trees these are typically `startNode` and the synthetic
 * Success / Failure terminals, but the shape works for any DAG.
 */
function getConnected(nodeId: string, edges: Edge[]) {
  // Build node set + in/out degree.
  const nodes = new Set<string>();
  const hasIn = new Set<string>();
  const hasOut = new Set<string>();
  for (const e of edges) {
    nodes.add(e.source); nodes.add(e.target);
    hasOut.add(e.source); hasIn.add(e.target);
  }
  const sources: string[] = [];
  const sinks: string[] = [];
  for (const n of nodes) {
    if (!hasIn.has(n)) sources.push(n);
    if (!hasOut.has(n)) sinks.push(n);
  }

  // Forward BFS from each source → every node reachable from any source.
  // If the graph has no pure sources (e.g. the data-flow graph where every
  // wildcard node both reads and writes) fall back to "no filter" — use the
  // raw ancestor closure. The alternative is the filter dropping everything
  // and the trace highlighting only the clicked node.
  const reachableFromSource = sources.length > 0 ? bfs(sources, edges, "forward") : null;
  // Backward BFS from each sink → every node that can reach any sink.
  const canReachSink = sinks.length > 0 ? bfs(sinks, edges, "backward") : null;

  // Ancestors (BFS backwards from nodeId) restricted to those that the
  // sources can reach — i.e. upstream nodes on a live start→nodeId path.
  const ancestorsAll = bfs([nodeId], edges, "backward");
  ancestorsAll.delete(nodeId);
  const ancestors = new Set<string>();
  for (const n of ancestorsAll) {
    if (!reachableFromSource || reachableFromSource.has(n)) ancestors.add(n);
  }

  // Descendants (BFS forwards from nodeId) restricted to those that can
  // reach some sink — i.e. downstream nodes on a live nodeId→terminal path.
  const descendantsAll = bfs([nodeId], edges, "forward");
  descendantsAll.delete(nodeId);
  const descendants = new Set<string>();
  for (const n of descendantsAll) {
    if (!canReachSink || canReachSink.has(n)) descendants.add(n);
  }

  return { ancestors, descendants };
}

function bfs(starts: string[], edges: Edge[], direction: "forward" | "backward"): Set<string> {
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      const next = direction === "forward"
        ? (e.source === cur ? e.target : null)
        : (e.target === cur ? e.source : null);
      if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return <JourneyLegendModal variant="normal" />;
}

// ── Node info drawer ─────────────────────────────────────────────────────────

interface NodePanelData {
  id: string;
  label: string;
  nodeType?: string;
  outcomes: { outcomeId: string; targetLabel: string }[];
}

const CONFIG_BLOCKLIST = new Set(["_id", "_rev", "_type", "_outcomes"]);

function PropertyValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);

  if (value === null || value === undefined) {
    return <span className="text-slate-400 italic text-[10px]">null</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span className={cn("text-[10px] font-mono font-medium", value ? "text-emerald-600" : "text-rose-500")}>
        {String(value)}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="text-[10px] font-mono text-amber-700">{value}</span>;
  }
  if (typeof value === "string") {
    return <span className="text-[10px] font-mono text-slate-700 break-all">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400 italic text-[10px]">[]</span>;
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-[10px] text-sky-600 hover:text-sky-800 font-mono"
        >
          {expanded ? "▾" : "▸"} [{value.length}]
        </button>
        {expanded && (
          <div className="mt-1 pl-2 border-l border-slate-200 space-y-1">
            {value.map((item, i) => (
              <div key={i} className="flex gap-1 items-start">
                <span className="text-[9px] text-slate-300 font-mono shrink-0 mt-0.5">{i}</span>
                <PropertyValue value={item} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-slate-400 italic text-[10px]">{"{}"}</span>;
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-[10px] text-sky-600 hover:text-sky-800 font-mono"
        >
          {expanded ? "▾" : "▸"} {"{…}"}
        </button>
        {expanded && (
          <div className="mt-1 pl-2 border-l border-slate-200 space-y-1.5">
            {entries.map(([k, v]) => (
              <div key={k} className="flex gap-1.5 items-start">
                <span className="text-[9px] text-slate-500 font-medium shrink-0 mt-0.5">{k}:</span>
                <PropertyValue value={v} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return <span className="text-[10px] font-mono text-slate-600">{String(value)}</span>;
}

function PropertyTable({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config).filter(([k]) => !CONFIG_BLOCKLIST.has(k));
  if (entries.length === 0) return <p className="text-[11px] text-slate-400">No properties</p>;
  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key}>
          <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">{key}</p>
          <PropertyValue value={value} />
        </div>
      ))}
    </div>
  );
}

// ── Node info drawer ──────────────────────────────────────────────────────────

function NodeInfoDrawer({
  node, open, environment, journeyId, onNavigate, onClose,
}: {
  node: NodePanelData | null;
  open: boolean;
  environment?: string;
  journeyId?: string;
  onNavigate?: (treeId: string, sourceNodeId: string) => void;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"config" | "script">("config");
  const [scriptContent, setScriptContent] = useState<string | null>(null);
  const [scriptName, setScriptName] = useState<string>("");
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptFullscreen, setScriptFullscreen] = useState(false);
  const [scriptCopied, setScriptCopied] = useState(false);
  const isStaticNode = !node || ["startNode", SUCCESS_ID, FAILURE_ID].includes(node.id);
  const isScriptedDecision = node?.nodeType === "ScriptedDecisionNode";

  // Reset tab + script when node changes
  useEffect(() => {
    setDrawerTab("config");
    setScriptContent(null);
    setScriptName("");
  }, [node?.id]);

  // Fetch node config
  useEffect(() => {
    if (!node || !environment || !journeyId || isStaticNode) { setConfig(null); return; }
    setConfigLoading(true);
    setConfig(null);
    const params = new URLSearchParams({ environment, journey: journeyId, nodeId: node.id });
    fetch(`/api/push/journey-node?${params}`)
      .then((r) => r.json())
      .then((d) => {
        try { setConfig(JSON.parse(d.file?.content ?? "")); }
        catch { setConfig(null); }
      })
      .catch(() => setConfig(null))
      .finally(() => setConfigLoading(false));
  }, [node?.id, environment, journeyId, isStaticNode]);

  // Fetch script content when script tab is active
  useEffect(() => {
    if (drawerTab !== "script") return;
    const scriptId = typeof config?.script === "string" ? config.script : null;
    if (!scriptId || !environment || scriptContent !== null) return;
    setScriptLoading(true);
    const params = new URLSearchParams({ environment, scriptId });
    fetch(`/api/push/script?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setScriptName(d.name ?? scriptId);
        setScriptContent(d.content ?? null);
      })
      .catch(() => setScriptContent(null))
      .finally(() => setScriptLoading(false));
  }, [drawerTab, config, environment, scriptContent]);

  const scriptHighlighted = useMemo(
    () => (scriptContent ? withLineNumbers(highlightJs(scriptContent)) : null),
    [scriptContent],
  );

  return (
    <>
      {scriptFullscreen && scriptContent && (
        <ScriptOverlay
          name={scriptName}
          content={scriptContent}
          onClose={() => setScriptFullscreen(false)}
        />
      )}

      <div className={cn(
        "absolute top-0 right-0 h-full w-72 bg-white border-l border-slate-200 shadow-2xl z-10",
        "flex flex-col transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "translate-x-full"
      )}>
        {node && (
          <>
            {/* Header */}
            <div className="flex items-start gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-800 leading-snug break-words">{node.label}</p>
                {node.nodeType && (
                  <span className={cn(
                    "inline-block mt-1.5 text-[10px] font-medium rounded px-1.5 py-0.5 border",
                    node.nodeType === "PageNode"
                      ? "text-violet-700 bg-violet-50 border-violet-200"
                      : "text-sky-700 bg-sky-50 border-sky-200"
                  )}>
                    {node.nodeType}
                  </span>
                )}
              </div>
              <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0 mt-0.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Tab bar — only for ScriptedDecisionNode */}
            {isScriptedDecision && (
              <div className="flex border-b border-slate-200 bg-white shrink-0">
                <button
                  type="button"
                  onClick={() => setDrawerTab("config")}
                  className={cn(
                    "flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2",
                    drawerTab === "config"
                      ? "border-sky-500 text-sky-700"
                      : "border-transparent text-slate-500 hover:text-slate-700"
                  )}
                >
                  Config
                </button>
                <button
                  type="button"
                  onClick={() => setDrawerTab("script")}
                  className={cn(
                    "flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2",
                    drawerTab === "script"
                      ? "border-sky-500 text-sky-700"
                      : "border-transparent text-slate-500 hover:text-slate-700"
                  )}
                >
                  Script
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {/* ── Config tab ── */}
              {drawerTab === "config" && (
                <>
                  {/* Outcomes */}
                  {node.outcomes.length > 0 && (
                    <div className="px-4 py-3 border-b border-slate-100">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Outcomes</p>
                      <div className="space-y-2">
                        {node.outcomes.map(({ outcomeId, targetLabel }) => (
                          <div key={outcomeId} className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] font-mono bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 shrink-0">
                              {outcomeId}
                            </span>
                            <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                            <span className="text-[11px] text-slate-700 truncate">{targetLabel}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Jump to inner tree */}
                  {node?.nodeType === "InnerTreeEvaluatorNode" && !!config?.tree && (
                    <div className="px-4 py-3 border-b border-slate-100">
                      <button
                        type="button"
                        onClick={() => onNavigate?.(String(config.tree), node!.id)}
                        className="w-full flex items-center gap-2 text-[11px] font-medium text-sky-700 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg px-3 py-2 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                        <span className="flex-1 text-left">Open inner tree</span>
                        <span className="font-mono text-[10px] text-sky-400 truncate max-w-[110px]">{String(config.tree)}</span>
                      </button>
                    </div>
                  )}

                  {/* Config properties */}
                  {!isStaticNode && (
                    <div className="px-4 py-3">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Configuration</p>
                      {configLoading && <p className="text-[11px] text-slate-400">Loading…</p>}
                      {!configLoading && config && <PropertyTable config={config} />}
                      {!configLoading && !config && (
                        <p className="text-[11px] text-slate-400">No configuration file found</p>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* ── Script tab ── */}
              {drawerTab === "script" && (
                <div className="flex flex-col h-full">
                  {scriptLoading && (
                    <p className="px-4 py-3 text-[11px] text-slate-400">Loading script…</p>
                  )}
                  {!scriptLoading && scriptContent === null && !configLoading && (
                    <p className="px-4 py-3 text-[11px] text-slate-400">
                      {typeof config?.script === "string" ? "Script file not found" : "No script linked"}
                    </p>
                  )}
                  {!scriptLoading && scriptContent !== null && (
                    <>
                      {/* Script name + copy + expand button */}
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50 shrink-0">
                        <svg className="w-3.5 h-3.5 text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                        </svg>
                        <span className="text-[10px] font-mono text-slate-600 truncate flex-1">{scriptName}</span>
                        <button
                          type="button"
                          title="Copy script"
                          onClick={() => {
                            navigator.clipboard.writeText(scriptContent!).then(() => {
                              setScriptCopied(true);
                              setTimeout(() => setScriptCopied(false), 2000);
                            });
                          }}
                          className="text-slate-400 hover:text-slate-600 shrink-0 transition-colors"
                        >
                          {scriptCopied ? (
                            <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                            </svg>
                          )}
                        </button>
                        <button
                          type="button"
                          title="View fullscreen"
                          onClick={() => setScriptFullscreen(true)}
                          className="text-slate-400 hover:text-slate-600 shrink-0"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                          </svg>
                        </button>
                      </div>
                      {/* Code preview */}
                      <div className="flex-1 overflow-auto bg-slate-950">
                        <pre
                          className="text-[10px] font-mono leading-relaxed p-3 text-slate-300"
                          dangerouslySetInnerHTML={{ __html: scriptHighlighted! }}
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── Inner graph ───────────────────────────────────────────────────────────────

function JourneyGraphInner({ json, fitViewKey, environment, journeyId, focusNodeId, compact }: {
  json: string; fitViewKey?: number; environment?: string; journeyId?: string; focusNodeId?: string; compact?: boolean;
}) {
  const { fitView, getViewport, setViewport } = useReactFlow();

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredEdgeId,  setHoveredEdgeId]  = useState<string | null>(null);
  const [pinnedEdgeId,   setPinnedEdgeId]   = useState<string | null>(null);
  const [searchQuery,    setSearchQuery]     = useState("");
  const [layoutKey,      setLayoutKey]       = useState(0);
  const [nodePanel,      setNodePanel]       = useState<NodePanelData | null>(null);
  const [pageConfigs,    setPageConfigs]     = useState<Map<string, PageNodeConfig>>(new Map());
  const [isCompact,      setIsCompact]       = useState(false);
  const [collapseChainsOn, setCollapseChainsOn] = useState(true);
  const [expandedChainIds, setExpandedChainIds] = useState<Set<string>>(new Set());
  const [layoutEngine, _setLayoutEngine] = useState<"dagre" | "elk">("elk");
  const [displayView,    setDisplayView]     = useState<"graph" | "outline" | "table" | "swimlane" | "json">("graph");
  // "control" = trace the outcome graph (default). "data" = trace shared-state
  // dependencies derived from every node's `inputs` / `outputs` arrays.
  const [traceMode,      setTraceMode]       = useState<"neighbors" | "upstream" | "downstream" | "data">("data");

  // ── Inner-tree navigation stack ───────────────────────────────────────────
  const [navStack,   setNavStack]   = useState<{ journeyId: string; json: string; sourceNodeId: string }[]>([]);
  const [navLoading, setNavLoading] = useState(false);
  const [flashNodeId, setFlashNodeId] = useState<string | null>(null);

  // Derive active journey from top of stack (falls back to props)
  const activeJson      = navStack.length > 0 ? navStack[navStack.length - 1].json      : json;
  const activeJourneyId = navStack.length > 0 ? navStack[navStack.length - 1].journeyId : journeyId;

  // Saved viewport per journey key (to restore when going back)
  const savedViewports     = useRef<Map<string, { x: number; y: number; zoom: number }>>(new Map());
  // null = fit view; non-null = restore this viewport
  const pendingViewport    = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // Only adjust viewport when an explicit navigation/layout action occurred,
  // not when dagreNodes changes due to pageConfigs loading
  const shouldAdjustViewport = useRef(true); // true for initial load

  // Reset stack when the parent selects a different journey
  useEffect(() => {
    setNavStack([]);
    savedViewports.current.clear();
    pendingViewport.current = null;
    shouldAdjustViewport.current = true;
  }, [json]);

  const navigateToTree = useCallback(async (treeId: string, sourceNodeId: string) => {
    if (!environment) return;
    // Save current viewport so we can restore it when going back
    savedViewports.current.set(activeJourneyId ?? "root", getViewport());
    pendingViewport.current = null; // signal: fit view on arrival
    shouldAdjustViewport.current = true;
    setNavLoading(true);
    try {
      const params = new URLSearchParams({ environment, scope: "journeys", item: treeId });
      const res = await fetch(`/api/push/item?${params}`);
      if (!res.ok) return;
      const data = await res.json() as { files: Array<{ content: string }> };
      const newJson = data.files?.[0]?.content;
      if (!newJson) return;
      setNavStack((prev) => [...prev, { journeyId: treeId, json: newJson, sourceNodeId }]);
      setNodePanel(null);
      setSelectedNodeId(null);
    } finally {
      setNavLoading(false);
    }
  }, [environment, activeJourneyId, getViewport]);

  const goToIndex = useCallback((index: number) => {
    const targetKey = index < 0 ? (journeyId ?? "root") : navStack[index].journeyId;
    pendingViewport.current = savedViewports.current.get(targetKey) ?? null;
    shouldAdjustViewport.current = true;
    // Flash the node in the parent that linked to the child we're leaving
    const flashTarget = navStack[index + 1]?.sourceNodeId ?? null;
    // Drop saved viewports for trees being removed from the path
    for (let i = index + 1; i < navStack.length; i++) {
      savedViewports.current.delete(navStack[i].journeyId);
    }
    setNavStack((prev) => index < 0 ? [] : prev.slice(0, index + 1));
    setFlashNodeId(flashTarget);
    setNodePanel(null);
    setSelectedNodeId(null);
  }, [navStack, journeyId]);

  // Detect PageNode and ScriptedDecisionNode IDs in the active journey JSON
  const [pageNodeIds, scriptNodeIds] = useMemo(() => {
    try {
      const data = JSON.parse(activeJson) as JourneyJson;
      const entries = Object.entries(data.nodes ?? {});
      return [
        entries.filter(([, n]) => n.nodeType === "PageNode").map(([id]) => id),
        entries.filter(([, n]) => n.nodeType === "ScriptedDecisionNode").map(([id]) => id),
      ];
    } catch { return [[], []]; }
  }, [activeJson]);

  // Fetch PageNode configs
  useEffect(() => {
    setPageConfigs(new Map());
    if (!environment || !activeJourneyId || pageNodeIds.length === 0) return;

    Promise.all(
      pageNodeIds.map(async (nodeId) => {
        const params = new URLSearchParams({ environment: environment!, journey: activeJourneyId!, nodeId });
        const res = await fetch(`/api/push/journey-node?${params}`);
        if (!res.ok) return null;
        const d = await res.json();
        if (!d.file?.content) return null;
        try { return [nodeId, JSON.parse(d.file.content) as PageNodeConfig] as const; }
        catch { return null; }
      })
    ).then((entries) => {
      const map = new Map<string, PageNodeConfig>(
        entries.filter((e): e is [string, PageNodeConfig] => e !== null)
      );
      setPageConfigs(map);
    });
  }, [environment, activeJourneyId, pageNodeIds]);

  // Preview modal for ScriptedDecisionNode / InnerTreeEvaluatorNode
  const [previewModal, setPreviewModal] = useState<{
    nodeId: string;
    nodeType: "ScriptedDecisionNode" | "InnerTreeEvaluatorNode";
    title: string;
    loading: boolean;
    scriptName?: string;
    scriptContent?: string;
    scriptCopied?: boolean;
    scriptFullscreen?: boolean;
    innerJourneyId?: string;
    innerJourneyJson?: string;
  } | null>(null);

  // Lock body scroll and auto-focus modal when open
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (previewModal) {
      document.body.style.overflow = "hidden";
      modalRef.current?.focus();
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [!!previewModal]);

  // Fetch preview content when modal opens
  useEffect(() => {
    if (!previewModal?.loading) return;
    if (!environment || !activeJourneyId) {
      setPreviewModal((p) => p ? { ...p, loading: false } : null);
      return;
    }
    const { nodeId, nodeType } = previewModal;
    let cancelled = false;

    const doFetch = async () => {
      try {
        const params = new URLSearchParams({ environment: environment!, journey: activeJourneyId!, nodeId });
        const res = await fetch(`/api/push/journey-node?${params}`);
        if (!res.ok || cancelled) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }
        const d = await res.json() as { file?: { content?: string } };
        const config = d.file?.content ? JSON.parse(d.file.content) as Record<string, unknown> : null;

        if (nodeType === "ScriptedDecisionNode") {
          const scriptId = typeof config?.script === "string" ? config.script : null;
          if (!scriptId || cancelled) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }
          const sParams = new URLSearchParams({ environment: environment!, scriptId });
          const sRes = await fetch(`/api/push/script?${sParams}`);
          if (!sRes.ok || cancelled) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }
          const sd = await sRes.json() as { name?: string; content?: string };
          if (cancelled) return;
          setPreviewModal((p) => p ? { ...p, loading: false, scriptName: sd.name, scriptContent: sd.content ?? undefined } : null);
        } else {
          const treeId = typeof config?.tree === "string" ? config.tree : null;
          if (!treeId || cancelled) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }
          const tParams = new URLSearchParams({ environment: environment!, scope: "journeys", item: treeId });
          const tRes = await fetch(`/api/push/item?${tParams}`);
          if (!tRes.ok || cancelled) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }
          const td = await tRes.json() as { files?: Array<{ content?: string }> };
          const innerJourneyJson = td.files?.[0]?.content;
          if (cancelled) return;
          setPreviewModal((p) => p ? { ...p, loading: false, innerJourneyId: treeId, innerJourneyJson } : null);
        }
      } catch {
        if (!cancelled) setPreviewModal((p) => p ? { ...p, loading: false } : null);
      }
    };

    void doFetch();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewModal?.nodeId, previewModal?.loading]);

  // Fetch script names for ScriptedDecisionNodes (for search)
  const [scriptNames, setScriptNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    setScriptNames(new Map());
    if (!environment || !activeJourneyId || scriptNodeIds.length === 0) return;
    let cancelled = false;
    Promise.all(
      scriptNodeIds.map(async (nodeId) => {
        try {
          const params = new URLSearchParams({ environment: environment!, journey: activeJourneyId!, nodeId });
          const res = await fetch(`/api/push/journey-node?${params}`);
          if (!res.ok) return null;
          const d = await res.json() as { file?: { content?: string } };
          if (!d.file?.content) return null;
          const config = JSON.parse(d.file.content) as Record<string, unknown>;
          const scriptId = typeof config.script === "string" ? config.script : null;
          if (!scriptId) return null;
          const sParams = new URLSearchParams({ environment: environment!, scriptId });
          const sRes = await fetch(`/api/push/script?${sParams}`);
          if (!sRes.ok) return null;
          const sd = await sRes.json() as { name?: string };
          return [nodeId, sd.name ?? scriptId] as const;
        } catch { return null; }
      })
    ).then((entries) => {
      if (cancelled) return;
      setScriptNames(new Map(entries.filter((e): e is [string, string] => e !== null)));
    });
    return () => { cancelled = true; };
  }, [environment, activeJourneyId, scriptNodeIds]);

  const { rawNodes, baseEdges, collapsedChains } = useMemo(() => {
    const parsed = parseJourney(activeJson, pageConfigs.size > 0 ? pageConfigs : undefined);
    const col = collapseChainsOn
      ? collapseChains(parsed.nodes, parsed.edges, expandedChainIds, CHAIN_MIN_LEN)
      : { nodes: parsed.nodes, edges: parsed.edges, chains: [] };
    return { rawNodes: col.nodes, baseEdges: col.edges, collapsedChains: col.chains };
  }, [activeJson, pageConfigs, collapseChainsOn, expandedChainIds]);

  const dagreNodes = useMemo(
    () => applyDagreLayout(rawNodes, baseEdges, isCompact),
    [rawNodes, baseEdges, isCompact, layoutKey],
  );

  // Helper: fit the current rfNodes or restore a saved viewport (once per
  // shouldAdjustViewport latch). Factored out because dagre and ELK effects
  // both consume the latch after laying out.
  const applyPendingViewport = useCallback(() => {
    if (!shouldAdjustViewport.current) return;
    shouldAdjustViewport.current = false;
    const vp = pendingViewport.current;
    pendingViewport.current = null;
    if (vp) setTimeout(() => setViewport(vp, { duration: 300 }), 80);
    else    setTimeout(() => fitView({ duration: 400, padding: 0.25 }), 80);
  }, [fitView, setViewport]);

  // Reset UI state whenever the graph shape changes (new journey, chain toggle,
  // compact toggle, layout-key bump). Engine toggle keeps selection.
  useEffect(() => {
    setSelectedNodeId(null);
    setSearchQuery("");
    setHoveredEdgeId(null);
    setPinnedEdgeId(null);
    setNodePanel(null);
  }, [dagreNodes]);

  // Apply dagre positions immediately. When ELK is the active engine, the
  // async ELK effect below will overwrite the positions once it resolves; we
  // still write dagre first so the graph shows up without a blank frame.
  useEffect(() => {
    setRfNodes(dagreNodes);
    if (layoutEngine === "elk") return; // ELK effect consumes the viewport latch
    applyPendingViewport();
  }, [dagreNodes, setRfNodes, layoutEngine, applyPendingViewport]);

  // ELK runs asynchronously; it overrides dagre positions once the layered
  // layout with aspectRatio returns, then consumes the viewport latch.
  useEffect(() => {
    if (layoutEngine !== "elk") return;
    let cancelled = false;
    applyElkLayout(rawNodes, baseEdges, isCompact).then((positioned) => {
      if (cancelled) return;
      setRfNodes(positioned);
      applyPendingViewport();
    });
    return () => { cancelled = true; };
  }, [rawNodes, baseEdges, isCompact, layoutEngine, layoutKey, setRfNodes, applyPendingViewport]);

  // Clear flash after animation completes
  useEffect(() => {
    if (!flashNodeId) return;
    const t = setTimeout(() => setFlashNodeId(null), 1200);
    return () => clearTimeout(t);
  }, [flashNodeId]);

  // Escape closes preview modal first, then drawer (capture phase, before fullscreen handler)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (previewModal) { setPreviewModal(null); e.stopPropagation(); return; }
        if (nodePanel) { setNodePanel(null); e.stopPropagation(); return; }
        if (selectedNodeId) { setSelectedNodeId(null); setPinnedEdgeId(null); e.stopPropagation(); }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [nodePanel, previewModal, selectedNodeId]);

  // Map nodeId → display label (for resolving outcome targets)
  const nodeDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    rfNodes.forEach((n) => { if (!n.parentId) map.set(n.id, String(n.data.label ?? n.id)); });
    map.set(SUCCESS_ID, "Success");
    map.set(FAILURE_ID, "Failure");
    map.set("startNode", "Start");
    return map;
  }, [rfNodes]);

  // Fit view when fullscreen toggles
  useEffect(() => {
    if (fitViewKey === undefined) return;
    const t = setTimeout(() => fitView({ duration: 400, padding: 0.25 }), 80);
    return () => clearTimeout(t);
  }, [fitViewKey, fitView]);

  // Focus on a specific node (zoom + select)
  useEffect(() => {
    if (!focusNodeId) return;
    const t = setTimeout(() => {
      const node = rfNodes.find((n) => n.id === focusNodeId);
      if (!node) return;
      setSelectedNodeId(focusNodeId);
      fitView({ nodes: [{ id: focusNodeId }], duration: 500, padding: 0.5, maxZoom: 1.5 });
    }, 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId]);

  // Arrow key panning
  useEffect(() => {
    const PAN = 120;
    const handler = (e: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      const vp = getViewport();
      const dx = e.key === "ArrowLeft" ? PAN : e.key === "ArrowRight" ? -PAN : 0;
      const dy = e.key === "ArrowUp"   ? PAN : e.key === "ArrowDown"  ? -PAN : 0;
      setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 100 });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [getViewport, setViewport]);

  // Search — match node label or script name (for ScriptedDecisionNode)
  const { searchMatches, searchMatchCount } = useMemo(() => {
    if (!searchQuery.trim()) return { searchMatches: new Set<string>(), searchMatchCount: 0 };
    const q = searchQuery.toLowerCase();
    const ids = new Set<string>();
    let count = 0;
    for (const n of rfNodes) {
      const labelMatch  = String(n.data.label ?? "").toLowerCase().includes(q);
      const scriptMatch = n.data.nodeType === "ScriptedDecisionNode" &&
        (scriptNames.get(n.id) ?? "").toLowerCase().includes(q);
      if (labelMatch || scriptMatch) {
        ids.add(n.id);
        count++;
        if (n.parentId) ids.add(n.parentId); // highlight parent group too
      }
    }
    return { searchMatches: ids, searchMatchCount: count };
  }, [searchQuery, rfNodes, scriptNames]);

  // Ordered list of top-level match IDs for prev/next navigation
  const searchMatchList = useMemo(
    () => rfNodes.filter((n) => !n.parentId && searchMatches.has(n.id)).map((n) => n.id),
    [rfNodes, searchMatches],
  );

  const [searchIndex, setSearchIndex] = useState(0);

  // Reset index whenever the match list changes (new query / new journey)
  useEffect(() => { setSearchIndex(0); }, [searchMatchList]);

  // Zoom to current match
  useEffect(() => {
    if (searchMatchList.length === 0) return;
    const id = searchMatchList[Math.min(searchIndex, searchMatchList.length - 1)];
    if (!id) return;
    const t = setTimeout(() => fitView({ nodes: [{ id }], duration: 500, padding: 0.4 }), 80);
    return () => clearTimeout(t);
  }, [searchIndex, searchMatchList, fitView]);

  const goSearchPrev = useCallback(() =>
    setSearchIndex((i) => (i - 1 + searchMatchList.length) % searchMatchList.length),
    [searchMatchList.length]);
  const goSearchNext = useCallback(() =>
    setSearchIndex((i) => (i + 1) % searchMatchList.length),
    [searchMatchList.length]);

  // Path tracing (top-level nodes only; edges only reference top-level IDs).
  // Trace mode dispatches to one of four behaviors — all over the control
  // (wiring) graph. "Data" == the full start→clicked→end closure; Upstream
  // and Downstream are the individual halves; Neighbors is the 1-hop set.
  const { ancestors, descendants } = useMemo(() => {
    if (!selectedNodeId) return { ancestors: new Set<string>(), descendants: new Set<string>() };
    if (traceMode === "neighbors") {
      const prev = new Set<string>();
      const next = new Set<string>();
      for (const e of baseEdges) {
        if (e.target === selectedNodeId) prev.add(e.source);
        if (e.source === selectedNodeId) next.add(e.target);
      }
      return { ancestors: prev, descendants: next };
    }
    const full = getConnected(selectedNodeId, baseEdges);
    if (traceMode === "upstream")   return { ancestors: full.ancestors, descendants: new Set<string>() };
    if (traceMode === "downstream") return { ancestors: new Set<string>(), descendants: full.descendants };
    return full;
  }, [selectedNodeId, baseEdges, traceMode]);

  // Control-flow reachability sets, computed once per journey. These drive
  // the trace-highlight filter regardless of trace mode (control / data /
  // neighbors / upstream / downstream) because dead-code determination is a
  // property of the control graph: a node only runs if the journey's
  // execution can reach it from start AND exit it toward a terminal.
  //   reachableFromStart — nodes any start→clicked path might touch
  //   reachableToEnd     — nodes any clicked→terminal path might touch
  const { reachableFromStart, reachableToEnd } = useMemo(() => {
    const nodes = new Set<string>();
    const hasIn = new Set<string>();
    const hasOut = new Set<string>();
    for (const e of baseEdges) {
      nodes.add(e.source); nodes.add(e.target);
      hasIn.add(e.target); hasOut.add(e.source);
    }
    const sources = [...nodes].filter((n) => !hasIn.has(n));
    const sinks   = [...nodes].filter((n) => !hasOut.has(n));
    return {
      reachableFromStart: bfs(sources, baseEdges, "forward"),
      reachableToEnd:     bfs(sinks,   baseEdges, "backward"),
    };
  }, [baseEdges]);

  const highlighted = useMemo(() => {
    if (!selectedNodeId) return null;
    // Orphan click: the clicked node itself isn't reachable from any start
    // AND / OR can't reach any end. Either way the journey can't run through
    // it, so the trace would be meaningless — skip the highlight entirely
    // (same visual as no-selection).
    if (!reachableFromStart.has(selectedNodeId)) return null;
    if (!reachableToEnd.has(selectedNodeId))     return null;
    // Upstream nodes are only kept if the journey could actually reach them
    // from a start; downstream nodes only if they can actually exit toward
    // a terminal. This second half is what data-mode was missing — the
    // data graph of an all-wildcard journey has no pure sinks, so the
    // getConnected filter fell back to "no filter" and dead-end data
    // descendants stayed highlighted.
    const filtered = new Set<string>([selectedNodeId]);
    for (const n of ancestors)   if (reachableFromStart.has(n)) filtered.add(n);
    for (const n of descendants) if (reachableToEnd.has(n))     filtered.add(n);
    return filtered;
  }, [selectedNodeId, ancestors, descendants, reachableFromStart, reachableToEnd]);

  // Styled nodes — children inherit parent opacity
  const displayNodes = useMemo<Node[]>(() => {
    const parentOpacity = new Map<string, number>();
    rfNodes.forEach((n) => {
      if (!n.parentId) {
        parentOpacity.set(n.id, highlighted ? (highlighted.has(n.id) ? 1 : 0.4) : 1);
      }
    });

    return rfNodes.map((n) => {
      if (n.parentId) {
        const opacity = parentOpacity.get(n.parentId) ?? 1;
        return { ...n, style: { ...n.style, opacity, transition: "opacity 0.2s" } };
      }
      return {
        ...n,
        data: { ...n.data, isSelected: n.id === selectedNodeId, isSearchMatch: searchMatches.has(n.id), isFlashing: n.id === flashNodeId },
        style: { ...n.style, opacity: highlighted ? (highlighted.has(n.id) ? 1 : 0.4) : 1, transition: "opacity 0.2s" },
      };
    });
  }, [rfNodes, selectedNodeId, highlighted, searchMatches, flashNodeId]);

  // Styled edges
  const displayEdges = useMemo<Edge[]>(() => {
    const activeEdgeId = hoveredEdgeId ?? pinnedEdgeId;
    return baseEdges.map((e) => {
      const isHovered = e.id === hoveredEdgeId;
      const isPinned  = e.id === pinnedEdgeId;
      const isActive  = e.id === activeEdgeId;
      // Strict on-path check: an edge is only on a start→clicked→end path if
      // it sits in one of these four positions. "Both endpoints highlighted"
      // is too permissive — it would light up a shortcut from an ancestor
      // straight to a descendant that bypasses the clicked node, or a
      // cycle back-edge from a descendant to an ancestor.
      const onPath = !highlighted ? true : (
        selectedNodeId != null && (
          (ancestors.has(e.source)   && ancestors.has(e.target))   ||   // upstream interior
          (ancestors.has(e.source)   && e.target === selectedNodeId) || // last edge into clicked
          (e.source === selectedNodeId && descendants.has(e.target)) || // first edge out of clicked
          (descendants.has(e.source) && descendants.has(e.target))      // downstream interior
        )
      );

      let opacity = 1;
      if (activeEdgeId)     opacity = isActive ? 1 : 0.25;
      else if (highlighted) opacity = onPath ? 1 : 0.25;

      const baseStroke = (e.style?.stroke as string | undefined) ?? "#64748b";
      const stroke = isHovered ? "#3b82f6" : isPinned ? "#7c3aed" : baseStroke;

      return {
        ...e,
        style: {
          ...e.style, opacity, strokeWidth: isActive ? 3 : 1.5, stroke,
          transition: "opacity 0.15s, stroke-width 0.15s",
        },
        animated: !activeEdgeId && onPath && !!highlighted,
        label: opacity < 0.5 ? undefined : e.label,
      };
    });
  }, [baseEdges, highlighted, hoveredEdgeId, pinnedEdgeId]);

  const handleNodeClick: NodeMouseHandler = useCallback((_e, node) => {
    if (node.parentId) return; // ignore clicks on page child nodes
    if (node.type === "chainCollapsed") {
      setExpandedChainIds((prev) => { const next = new Set(prev); next.add(node.id); return next; });
      return;
    }
    const d = node.data as { label: string; nodeType?: string; outcomes?: string[] };

    const isSame = selectedNodeId === node.id;
    setSelectedNodeId(isSame ? null : node.id);
    if (isSame) {
      setNodePanel(null);
    } else {
      const outcomes = (d.outcomes ?? []).map((outcomeId) => {
        const edge = baseEdges.find((e) => e.source === node.id && e.sourceHandle === outcomeId);
        const targetLabel = edge ? (nodeDisplayMap.get(edge.target) ?? edge.target) : "—";
        return { outcomeId, targetLabel };
      });
      setNodePanel({ id: node.id, label: d.label, nodeType: d.nodeType, outcomes });
    }
  }, [selectedNodeId, baseEdges, nodeDisplayMap]);

  const handleNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    if (node.parentId) return;
    const d = node.data as { label: string; nodeType?: string; outcomes?: string[] };
    if (d.nodeType === "ScriptedDecisionNode" || d.nodeType === "InnerTreeEvaluatorNode") {
      setPreviewModal({ nodeId: node.id, nodeType: d.nodeType, title: d.label ?? node.id, loading: true });
      // Ensure side panel is also open
      if (selectedNodeId !== node.id) {
        setSelectedNodeId(node.id);
        const outcomes = (d.outcomes ?? []).map((outcomeId) => {
          const edge = baseEdges.find((e) => e.source === node.id && e.sourceHandle === outcomeId);
          const targetLabel = edge ? (nodeDisplayMap.get(edge.target) ?? edge.target) : "—";
          return { outcomeId, targetLabel };
        });
        setNodePanel({ id: node.id, label: d.label, nodeType: d.nodeType, outcomes });
      }
    }
  }, [selectedNodeId, baseEdges, nodeDisplayMap]);

  const handleEdgeMouseEnter: EdgeMouseHandler = useCallback((_e, edge) => setHoveredEdgeId(edge.id), []);
  const handleEdgeMouseLeave: EdgeMouseHandler = useCallback(() => setHoveredEdgeId(null), []);
  const handleEdgeClick: EdgeMouseHandler      = useCallback((_e, edge) => setPinnedEdgeId((p) => p === edge.id ? null : edge.id), []);
  // Two-stage pane click: first click closes drawer (keeps trace highlight);
  // next click clears selection + pinned edge (drops highlight).
  const handlePaneClick = useCallback(() => {
    if (nodePanel) { setNodePanel(null); return; }
    setSelectedNodeId(null);
    setPinnedEdgeId(null);
  }, [nodePanel]);

  if (rfNodes.length === 0 && dagreNodes.length === 0) {
    return <div className="flex items-center justify-center h-full text-sm text-slate-400">Unable to parse journey data</div>;
  }

  return (
    <div className="flex flex-col w-full h-full overflow-hidden">
      {/* ── Header bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-slate-200 shrink-0">

        {/* Inner-tree breadcrumb (journey name lives in the parent header bar) */}
        <div className="flex-1 min-w-0">
          {navStack.length > 0 && (
            <nav className="flex items-center gap-1 text-sm min-w-0">
              <button
                type="button"
                onClick={() => goToIndex(-1)}
                title="Back to top-level journey"
                className="text-slate-400 hover:text-sky-600 shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12 12 2.25 21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                </svg>
              </button>
              {navStack.map((entry, i) => (
                <Fragment key={`${entry.journeyId}-${i}`}>
                  <span className="text-slate-400 shrink-0">›</span>
                  {i < navStack.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => goToIndex(i)}
                      className="text-sky-600 hover:text-sky-800 truncate max-w-[160px]"
                    >
                      {entry.journeyId}
                    </button>
                  ) : (
                    <span className="font-semibold text-slate-800 truncate max-w-[160px]">{entry.journeyId}</span>
                  )}
                </Fragment>
              ))}
              {navLoading && <span className="text-slate-400 ml-1 shrink-0">…</span>}
            </nav>
          )}
        </div>

        {/* Search */}
        <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded px-2 py-1 shrink-0">
          <svg className="w-3 h-3 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search nodes…"
            className="text-xs w-28 outline-none text-slate-700 placeholder-slate-400 bg-transparent"
          />
          {searchQuery && (
            <>
              <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
                {searchMatchList.length > 1 ? `${searchIndex + 1} / ${searchMatchList.length}` : `${searchMatchCount} match${searchMatchCount !== 1 ? "es" : ""}`}
              </span>
              <button type="button" onClick={() => setSearchQuery("")} title="Clear search" className="text-slate-400 hover:text-slate-600 shrink-0">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {searchMatchList.length > 1 && (
                <>
                  <div className="w-px h-3.5 bg-slate-200 shrink-0" />
                  <button type="button" onClick={goSearchPrev} title="Previous match" className="text-slate-400 hover:text-sky-600 shrink-0 text-sm leading-none">‹</button>
                  <button type="button" onClick={goSearchNext} title="Next match"     className="text-slate-400 hover:text-sky-600 shrink-0 text-sm leading-none">›</button>
                </>
              )}
            </>
          )}
        </div>

        {/* Display view toggle */}
        <div className="flex rounded border border-slate-300 overflow-hidden text-[11px] shrink-0">
          {(["graph", "outline", "table", "swimlane", "json"] as const).map((v, i) => (
            <button
              key={v}
              type="button"
              onClick={() => setDisplayView(v)}
              className={cn(
                "px-2.5 py-1 transition-colors",
                i > 0 && "border-l border-slate-300",
                displayView === v
                  ? "bg-sky-600 text-white"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
              )}
            >
              {v === "swimlane" ? "Swim" : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        {/* Graph-only controls */}
        {displayView === "graph" && (<>
          {/* Trace mode toggle */}
          <div className="flex rounded border border-slate-200 overflow-hidden text-[11px] shrink-0">
            {(["neighbors", "upstream", "downstream", "data"] as const).map((m) => {
              const label = m === "neighbors"
                ? "Neighbors"
                : m === "upstream"
                  ? "Upstream"
                  : m === "downstream"
                    ? "Downstream"
                    : "Data";
              const title =
                m === "neighbors"   ? "Highlight only the nodes directly connected to the clicked node (1 hop)"
                : m === "upstream"  ? "Highlight every path from a start node into the clicked node"
                : m === "downstream"? "Highlight every path from the clicked node to a terminal (Success / Failure)"
                                    : "Highlight every start→clicked→end path — the full wiring trace through the clicked node";
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setTraceMode(m)}
                  title={title}
                  className={cn(
                    "px-2 py-1 transition-colors",
                    traceMode === m ? "bg-sky-600 text-white" : "text-slate-500 hover:bg-slate-100",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Reset layout */}
          <button
            type="button"
            onClick={() => { shouldAdjustViewport.current = true; setLayoutKey((k) => k + 1); }}
            title="Reset layout"
            className="text-slate-400 hover:text-sky-600 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>

          {/* Collapse passthrough chains */}
          <button
            type="button"
            onClick={() => {
              shouldAdjustViewport.current = true;
              setCollapseChainsOn((v) => !v);
              setExpandedChainIds(new Set());
            }}
            title={
              collapseChainsOn
                ? `Showing collapsed chains (≥ ${CHAIN_MIN_LEN} linear steps folded into one pill). Click to show all nodes.`
                : "Fold linear runs of single-step nodes into collapsible pills."
            }
            className={cn(
              "px-2.5 py-1 text-[11px] rounded border transition-colors shrink-0 flex items-center gap-1",
              collapseChainsOn
                ? "bg-sky-600 text-white border-sky-600"
                : "text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400",
            )}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M6 12h.01M12 12h.01M18 12h.01M3 6h18M3 18h18" />
            </svg>
            Fold runs{collapsedChains.length > 0 ? ` (${collapsedChains.length})` : ""}
          </button>

          {/* Compact layout */}
          <button
            type="button"
            onClick={() => { shouldAdjustViewport.current = true; setIsCompact((v) => !v); }}
            title={isCompact ? "Switch to normal layout" : "Switch to compact layout"}
            className={cn(
              "px-2.5 py-1 text-[11px] rounded border transition-colors shrink-0 flex items-center gap-1",
              isCompact
                ? "bg-sky-600 text-white border-sky-600"
                : "text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400",
            )}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
            </svg>
            Compact
          </button>

        </>)}

      </div>

      {/* ── Content area ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {displayView !== "graph" ? (
          (() => {
            if (!activeJson) return <div className="flex items-center justify-center h-full text-sm text-slate-400">No content available</div>;
            if (displayView === "outline")  return <div className="h-full overflow-auto"><JourneyOutlineView  json={activeJson} /></div>;
            if (displayView === "table")    return <div className="h-full overflow-auto"><JourneyTableView    json={activeJson} environment={environment} journeyId={activeJourneyId} /></div>;
            if (displayView === "swimlane") return <div className="h-full overflow-auto"><JourneySwimLaneView json={activeJson} /></div>;
            if (displayView === "json") return (
              <div className="h-full overflow-auto bg-slate-950 p-4">
                <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all">{activeJson}</pre>
              </div>
            );
            return null;
          })()
        ) : (
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onEdgeMouseEnter={handleEdgeMouseEnter}
            onEdgeMouseLeave={handleEdgeMouseLeave}
            onEdgeClick={handleEdgeClick}
            onPaneClick={handlePaneClick}
            nodesDraggable
            snapToGrid
            snapGrid={[20, 20]}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.1}
            maxZoom={2}
          >
            {!compact && (
              <Panel position="top-left">
                <Legend />
              </Panel>
            )}
            <Background color="#e2e8f0" gap={20} size={1} />
            <Controls showInteractive={false} showFitView={false}>
              <ControlButton
                onClick={() => { shouldAdjustViewport.current = true; fitView({ duration: 400, padding: 0.25 }); }}
                title="Fit view"
              >
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
              </ControlButton>
            </Controls>
            {!compact && (
              <MiniMap
                nodeColor={(n) =>
                  n.type === "successNode" ? "#34d399" :
                  n.type === "failureNode" ? "#f87171" :
                  n.type === "startNode"   ? "#10b981" :
                  n.type === "pageGroup"   ? "#ddd6fe" :
                  n.type === "pageChild"   ? "#ede9fe" : "#cbd5e1"
                }
                zoomable pannable
              />
            )}
          </ReactFlow>
        )}

        <NodeInfoDrawer
          node={nodePanel}
          open={!!nodePanel}
          environment={environment}
          journeyId={activeJourneyId}
          onNavigate={navigateToTree}
          onClose={() => setNodePanel(null)}
        />
      </div>

      {/* ── Preview modal (ScriptedDecisionNode / InnerTreeEvaluatorNode) ─────── */}
      {previewModal && (
        <>
          {previewModal.scriptFullscreen && previewModal.scriptContent ? (
            <ScriptOverlay
              name={previewModal.scriptName ?? previewModal.title}
              content={previewModal.scriptContent}
              onClose={() => setPreviewModal((p) => p ? { ...p, scriptFullscreen: false } : null)}
            />
          ) : (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/40"
            onClick={() => setPreviewModal(null)}
          >
            <div
              ref={modalRef}
              tabIndex={-1}
              className="bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden outline-none"
              style={{
                width:     previewModal.nodeType === "InnerTreeEvaluatorNode" ? "80vw" : "60vw",
                maxWidth:  960,
                height:    previewModal.nodeType === "InnerTreeEvaluatorNode" ? "75vh" : "60vh",
                maxHeight: "90vh",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{previewModal.title}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {previewModal.nodeType === "ScriptedDecisionNode" ? "Script preview" : "Inner journey preview"}
                  </p>
                </div>
                {previewModal.nodeType === "InnerTreeEvaluatorNode" && previewModal.innerJourneyId && !previewModal.loading && (
                  <button
                    type="button"
                    onClick={() => { void navigateToTree(previewModal.innerJourneyId!, previewModal.nodeId); setPreviewModal(null); }}
                    className="px-3 py-1.5 text-xs font-medium rounded border border-sky-600 text-sky-600 hover:bg-sky-50 transition-colors shrink-0"
                  >
                    Navigate in →
                  </button>
                )}
                {previewModal.nodeType === "ScriptedDecisionNode" && previewModal.scriptContent && !previewModal.loading && (
                  <>
                    <button
                      type="button"
                      title="Copy script"
                      onClick={() => {
                        void navigator.clipboard.writeText(previewModal.scriptContent!).then(() => {
                          setPreviewModal((p) => p ? { ...p, scriptCopied: true } : null);
                          setTimeout(() => setPreviewModal((p) => p ? { ...p, scriptCopied: false } : null), 2000);
                        });
                      }}
                      className="text-slate-400 hover:text-slate-600 shrink-0 transition-colors"
                    >
                      {previewModal.scriptCopied ? (
                        <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      title="View fullscreen"
                      onClick={() => setPreviewModal((p) => p ? { ...p, scriptFullscreen: true } : null)}
                      className="text-slate-400 hover:text-slate-600 shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                      </svg>
                    </button>
                  </>
                )}
                <button type="button" onClick={() => setPreviewModal(null)} className="text-slate-400 hover:text-slate-600 shrink-0">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Modal body */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {previewModal.loading ? (
                  <div className="flex items-center justify-center h-full text-sm text-slate-400">Loading…</div>
                ) : previewModal.nodeType === "ScriptedDecisionNode" ? (
                  <div className="h-full flex flex-col overflow-hidden bg-slate-950">
                    {previewModal.scriptName && (
                      <p className="px-4 pt-3 pb-1 text-[10px] font-medium text-slate-400 shrink-0">{previewModal.scriptName}</p>
                    )}
                    {previewModal.scriptContent ? (
                      <div className="flex-1 overflow-auto">
                        <pre
                          className="px-4 pb-4 text-[11px] font-mono leading-relaxed text-slate-300"
                          dangerouslySetInnerHTML={{ __html: withLineNumbers(highlightJs(previewModal.scriptContent)) }}
                        />
                      </div>
                    ) : (
                      <p className="px-4 py-4 text-sm text-slate-400">No script content available.</p>
                    )}
                  </div>
                ) : (
                  previewModal.innerJourneyJson ? (
                    <JourneyGraph json={previewModal.innerJourneyJson} environment={environment} journeyId={previewModal.innerJourneyId} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-sm text-slate-400">Could not load inner journey.</div>
                  )
                )}
              </div>
            </div>
          </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Public export ─────────────────────────────────────────────────────────────

export function JourneyGraph({ json, fitViewKey, environment, journeyId, focusNodeId, compact }: { json: string; fitViewKey?: number; environment?: string; journeyId?: string; focusNodeId?: string; compact?: boolean }) {
  return (
    <ReactFlowProvider>
      <JourneyGraphInner json={json} fitViewKey={fitViewKey} environment={environment} journeyId={journeyId} focusNodeId={focusNodeId} compact={compact} />
    </ReactFlowProvider>
  );
}
