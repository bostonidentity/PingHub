"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
  type Viewport,
  type EdgeMouseHandler,
} from "@xyflow/react";
import { cn } from "@/lib/utils";

type DiffStatus = "added" | "removed" | "modified" | "unchanged";

export interface DiffGraphCanvasProps {
  baseNodes: Node[];
  baseEdges: Edge[];
  nodeTypes: NodeTypes;
  hideUnchanged: boolean;
  isCompact: boolean;
  fitKey: number;
  externalViewport: Viewport | null;
  onViewportChange: (vp: Viewport) => void;
  searchQuery: string;
  flashNodeId: string | null;
  zoomToNodeId?: string | null;
  onNodeActivate?: (nodeId: string | null, data: Record<string, unknown>) => void;
  onNodeDoubleClick?: (nodeId: string, data: Record<string, unknown>) => void;
  onPaneClearFocus?: () => void;
  /** Optional: transform raw nodes into laid-out nodes. If omitted, baseNodes are used as-is. */
  applyLayout?: (nodes: Node[], edges: Edge[]) => Node[];
  /** Optional: alternative layout used when isCompact is true. Falls back to applyLayout. */
  applyCompactLayout?: (nodes: Node[], edges: Edge[]) => Node[];
  /** Optional: color function for the minimap. Default maps by data.diffStatus. */
  miniMapNodeColor?: (node: Node) => string;
  /** Optional: content rendered in a top-left Panel inside the canvas (e.g., a legend). */
  legend?: React.ReactNode;
  /** Optional: extra search targets keyed by node id (journey uses this for script names). */
  scriptNames?: Map<string, string>;
  className?: string;
}

function defaultMiniMapNodeColor(n: Node): string {
  const d = n.data as { diffStatus?: DiffStatus };
  switch (d.diffStatus) {
    case "added":    return "#10b981";
    case "removed":  return "#ef4444";
    case "modified": return "#f59e0b";
    default:         return "#94a3b8";
  }
}

function getConnected(nodeId: string, edges: Edge[]): { ancestors: Set<string>; descendants: Set<string> } {
  const ancestors = new Set<string>();
  const descendants = new Set<string>();
  const upQueue = [nodeId];
  while (upQueue.length) {
    const cur = upQueue.shift()!;
    for (const e of edges) {
      if (e.target === cur && !ancestors.has(e.source)) {
        ancestors.add(e.source);
        upQueue.push(e.source);
      }
    }
  }
  const downQueue = [nodeId];
  while (downQueue.length) {
    const cur = downQueue.shift()!;
    for (const e of edges) {
      if (e.source === cur && !descendants.has(e.target)) {
        descendants.add(e.target);
        downQueue.push(e.target);
      }
    }
  }
  return { ancestors, descendants };
}

function DiffGraphCanvasInner({
  baseNodes,
  baseEdges,
  nodeTypes,
  hideUnchanged,
  isCompact,
  fitKey,
  externalViewport,
  onViewportChange,
  onNodeActivate,
  onNodeDoubleClick: onNodeDoubleClickProp,
  searchQuery,
  flashNodeId,
  onPaneClearFocus,
  zoomToNodeId,
  applyLayout,
  applyCompactLayout,
  miniMapNodeColor,
  legend,
  scriptNames,
}: Omit<DiffGraphCanvasProps, "className">) {
  const { fitView, setViewport, getViewport } = useReactFlow();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId]   = useState<string | null>(null);
  const [pinnedEdgeId, setPinnedEdgeId]     = useState<string | null>(null);

  const layoutedNodes = useMemo(() => {
    const fn = isCompact
      ? (applyCompactLayout ?? applyLayout)
      : applyLayout;
    return fn ? fn(baseNodes, baseEdges) : baseNodes;
  }, [baseNodes, baseEdges, isCompact, applyLayout, applyCompactLayout]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);

  useEffect(() => {
    setNodes(layoutedNodes);
    if (zoomToNodeId) return;
    const t = setTimeout(() => { void fitView({ duration: 200 }); }, 80);
    return () => clearTimeout(t);
  }, [layoutedNodes, setNodes, fitView, zoomToNodeId]);

  useEffect(() => {
    void fitView({ duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  useEffect(() => {
    if (externalViewport) setViewport(externalViewport, { duration: 0 });
  }, [externalViewport, setViewport]);

  const handleEdgeMouseEnter: EdgeMouseHandler = useCallback((_e, edge) => setHoveredEdgeId(edge.id), []);
  const handleEdgeMouseLeave: EdgeMouseHandler = useCallback(() => setHoveredEdgeId(null), []);
  const handleEdgeClick:      EdgeMouseHandler = useCallback((_e, edge) => setPinnedEdgeId((p) => p === edge.id ? null : edge.id), []);

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

  useEffect(() => {
    if (!zoomToNodeId) return;
    const t = setTimeout(() => {
      void fitView({ nodes: [{ id: zoomToNodeId }], duration: 600, padding: 0.35 });
    }, 350);
    return () => clearTimeout(t);
  }, [zoomToNodeId, fitView]);

  const visibleNodeIds = useMemo(() => {
    if (!hideUnchanged) return new Set(nodes.map((n) => n.id));
    return new Set(
      nodes
        .filter((n) => (n.data.diffStatus as DiffStatus) !== "unchanged")
        .map((n) => n.id),
    );
  }, [nodes, hideUnchanged]);

  const filteredNodes = useMemo(
    () => nodes.filter((n) => visibleNodeIds.has(n.id)),
    [nodes, visibleNodeIds],
  );

  const filteredEdges = useMemo(
    () => baseEdges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
    ),
    [baseEdges, visibleNodeIds],
  );

  useEffect(() => {
    if (!selectedNodeId) return;
    if (!filteredNodes.some((n) => n.id === selectedNodeId)) {
      setSelectedNodeId(null);
      onNodeActivate?.(null, {});
    }
  }, [filteredNodes, selectedNodeId, onNodeActivate]);

  const highlighted = useMemo(() => {
    if (!selectedNodeId) return null;
    const { ancestors, descendants } = getConnected(selectedNodeId, filteredEdges);
    return new Set([selectedNodeId, ...ancestors, ...descendants]);
  }, [selectedNodeId, filteredEdges]);

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return new Set<string>();
    const q = searchQuery.toLowerCase();
    const ids = new Set<string>();
    for (const n of nodes) {
      const labelMatch  = String(n.data.label ?? n.data.displayName ?? "").toLowerCase().includes(q);
      const scriptMatch = n.data.nodeType === "ScriptedDecisionNode" &&
        (scriptNames?.get(n.id) ?? "").toLowerCase().includes(q);
      if (labelMatch || scriptMatch) {
        ids.add(n.id);
        if (n.parentId) ids.add(n.parentId);
      }
    }
    return ids;
  }, [searchQuery, nodes, scriptNames]);

  useEffect(() => {
    if (searchMatches.size === 0) return;
    const topIds = [...searchMatches].filter((id) => !id.includes("__child__"));
    if (topIds.length === 0) return;
    const t = setTimeout(() => {
      void fitView({ nodes: topIds.map((id) => ({ id })), duration: 500, padding: 0.4 });
    }, 50);
    return () => clearTimeout(t);
  }, [searchMatches, fitView]);

  const styledNodes = useMemo(() => {
    return filteredNodes.map((n) => {
      const onPath = highlighted ? highlighted.has(n.id) : true;
      return {
        ...n,
        data: {
          ...n.data,
          isFocused:     n.id === flashNodeId,
          isSearchMatch: searchMatches.has(n.id),
          isCompact,
        },
        style: {
          ...n.style,
          opacity: highlighted ? (onPath ? 1 : 0.15) : 1,
          transition: "opacity 0.2s",
        },
      };
    });
  }, [filteredNodes, highlighted, flashNodeId, searchMatches, isCompact]);

  const styledEdges = useMemo(() => {
    const activeEdgeId = hoveredEdgeId ?? pinnedEdgeId;
    return filteredEdges.map((e) => {
      const isHovered = e.id === hoveredEdgeId;
      const isPinned  = e.id === pinnedEdgeId;
      const isActive  = e.id === activeEdgeId;
      const onPath    = highlighted ? (highlighted.has(e.source) && highlighted.has(e.target)) : true;

      let opacity = 1;
      if (activeEdgeId)     opacity = isActive ? 1 : 0.06;
      else if (highlighted) opacity = onPath ? 1 : 0.06;

      const baseStroke = (e.style?.stroke as string | undefined) ?? "#64748b";
      const stroke = isHovered ? "#3b82f6" : isPinned ? "#7c3aed" : baseStroke;

      return {
        ...e,
        style: { ...e.style, opacity, strokeWidth: isActive ? 3 : 1.5, stroke, transition: "opacity 0.15s, stroke-width 0.15s" },
        animated: !activeEdgeId && onPath && !!highlighted,
        label: opacity < 0.5 ? undefined : e.label,
      };
    });
  }, [filteredEdges, highlighted, hoveredEdgeId, pinnedEdgeId]);

  const miniColor = miniMapNodeColor ?? defaultMiniMapNodeColor;

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const nodeData = node.data as Record<string, unknown>;
    if (selectedNodeId === node.id) {
      setSelectedNodeId(null);
      onNodeActivate?.(null, {});
    } else {
      setSelectedNodeId(node.id);
      onNodeActivate?.(node.id, nodeData);
    }
  }, [selectedNodeId, onNodeActivate]);

  const handleNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    onNodeDoubleClickProp?.(node.id, node.data as Record<string, unknown>);
  }, [onNodeDoubleClickProp]);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
    onNodeActivate?.(null, {});
    onPaneClearFocus?.();
  }, [onNodeActivate, onPaneClearFocus]);

  return (
    <ReactFlow
      nodes={styledNodes}
      edges={styledEdges}
      nodeTypes={nodeTypes}
      onMove={(_, vp) => onViewportChange(vp)}
      onNodeClick={handleNodeClick}
      onNodeDoubleClick={handleNodeDoubleClick}
      onPaneClick={handlePaneClick}
      onEdgeMouseEnter={handleEdgeMouseEnter}
      onEdgeMouseLeave={handleEdgeMouseLeave}
      onEdgeClick={handleEdgeClick}
      onNodesChange={onNodesChange}
      nodesDraggable
      snapToGrid
      snapGrid={[20, 20]}
      fitView
      minZoom={0.1}
      maxZoom={2}
    >
      <Background color="#e2e8f0" gap={20} size={1} />
      <Controls showInteractive={false} showFitView={false} />
      <MiniMap nodeColor={miniColor} zoomable pannable />
      {legend && <Panel position="top-left">{legend}</Panel>}
    </ReactFlow>
  );
}

export function DiffGraphCanvas({ className, ...innerProps }: DiffGraphCanvasProps) {
  return (
    <div className={cn("w-full h-full", className)}>
      <ReactFlowProvider>
        <DiffGraphCanvasInner {...innerProps} />
      </ReactFlowProvider>
    </div>
  );
}
