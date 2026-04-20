import type { Node, Edge } from "@xyflow/react";

// ── Types & constants ─────────────────────────────────────────────────────────

export type DiffStatus = "added" | "removed" | "modified" | "unchanged";

export const DIFF_SUCCESS_ID = "e301438c-0bd0-429c-ab0c-66126501069a";
export const DIFF_FAILURE_ID = "70e691a5-1e33-4ac3-a356-e7b6d60d92e0";
export const DIFF_NODE_W     = 175;
export const DIFF_NODE_H     = 64;
export const DIFF_TERM_SIZE  = 60;
export const DIFF_START_SIZE = 48;

// Page group
export const DIFF_PAGE_GROUP_W   = 199;
export const DIFF_PAGE_CHILD_W   = 175;
export const DIFF_PAGE_CHILD_H   = 30;
export const DIFF_PAGE_GROUP_TOP = 42;
export const DIFF_PAGE_GROUP_PAD = 12;
export const DIFF_PAGE_CHILD_GAP = 6;

export interface PageChildConfig {
  _id: string;
  displayName: string;
  nodeType: string;
}

export interface PageNodeConfig {
  nodes?: PageChildConfig[];
}

export function diffNodeHeight(outcomeCount: number): number {
  return Math.max(DIFF_NODE_H, outcomeCount * 22 + 28);
}

export function diffPageGroupHeight(childCount: number): number {
  return DIFF_PAGE_GROUP_TOP
    + childCount * DIFF_PAGE_CHILD_H
    + Math.max(0, childCount - 1) * DIFF_PAGE_CHILD_GAP
    + DIFF_PAGE_GROUP_PAD;
}

// ── Journey JSON shape ────────────────────────────────────────────────────────

interface JourneyJsonNode {
  displayName?: string;
  nodeType?: string;
  connections?: Record<string, string>;
  x: number;
  y: number;
}

interface JourneyJson {
  entryNodeId?: string;
  nodes?: Record<string, JourneyJsonNode>;
  staticNodes?: Record<string, { x: number; y: number }>;
}

function parseJson(content: string): JourneyJson | null {
  try { return JSON.parse(content) as JourneyJson; } catch { return null; }
}

// ── Edge styling helpers ──────────────────────────────────────────────────────

function edgeColor(status: DiffStatus, targetId: string): string {
  if (status === "added")    return "#10b981";
  if (status === "removed")  return "#ef4444";
  if (status === "modified") return "#f59e0b";
  if (targetId === DIFF_FAILURE_ID) return "#f87171";
  if (targetId === DIFF_SUCCESS_ID) return "#34d399";
  return "#64748b";
}

type SvgStyle = Record<string, string | number>;

function makeEdgeStyle(status: DiffStatus, targetId: string): SvgStyle {
  const style: SvgStyle = {
    stroke: edgeColor(status, targetId),
    strokeWidth: 1.5,
  };
  if (status === "removed") {
    style.strokeDasharray = "5,5";
  }
  return style;
}

// ── parseMergedDiffGraph ──────────────────────────────────────────────────────

/**
 * Merge local + remote journey JSONs into one graph.
 * Every node / edge carries `data.diffStatus`.
 */
export function parseMergedDiffGraph(
  localContent: string | undefined,
  remoteContent: string | undefined,
  nodeStatusMap: Map<string, DiffStatus>,
  nodeModifiedReasonMap?: Map<string, "script" | "subjourney">,
  pageConfigs?: Map<string, PageNodeConfig>,
): { nodes: Node[]; edges: Edge[] } {
  const local  = localContent  ? parseJson(localContent)  : null;
  const remote = remoteContent ? parseJson(remoteContent) : null;

  if (!local && !remote) return { nodes: [], edges: [] };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // ── Static nodes (startNode, success, failure) ──────────────────────────

  const allStaticIds = new Set([
    ...Object.keys(local?.staticNodes  ?? {}),
    ...Object.keys(remote?.staticNodes ?? {}),
  ]);

  for (const id of allStaticIds) {
    const inLocal  = !!local?.staticNodes?.[id];
    const inRemote = !!remote?.staticNodes?.[id];
    const status: DiffStatus = inLocal && inRemote ? "unchanged" : inRemote ? "added" : "removed";

    const pos = remote?.staticNodes?.[id] ?? local?.staticNodes?.[id] ?? { x: 0, y: 0 };

    const type =
      id === "startNode"       ? "startNode"   :
      id === DIFF_SUCCESS_ID   ? "successNode" :
      id === DIFF_FAILURE_ID   ? "failureNode" : "successNode";

    rfNodes.push({
      id,
      type,
      position: { x: pos.x, y: pos.y },
      data: { label: id, diffStatus: status },
    });
  }

  // ── Start edge ───────────────────────────────────────────────────────────

  const localEntry  = local?.entryNodeId;
  const remoteEntry = remote?.entryNodeId;
  if (localEntry || remoteEntry) {
    const hasStart  = !!(local?.staticNodes?.["startNode"] || remote?.staticNodes?.["startNode"]);
    if (hasStart) {
      const entryId = remoteEntry ?? localEntry!;
      const status: DiffStatus =
        localEntry && remoteEntry
          ? (localEntry === remoteEntry ? "unchanged" : "modified")
          : remoteEntry ? "added" : "removed";
      rfEdges.push({
        id: "__start__",
        source: "startNode",
        target: entryId,

        style: makeEdgeStyle(status, entryId),
        data: { diffStatus: status },
      });
    }
  }

  // ── Regular nodes ────────────────────────────────────────────────────────

  const allNodeIds = new Set([
    ...Object.keys(local?.nodes  ?? {}),
    ...Object.keys(remote?.nodes ?? {}),
  ]);

  for (const id of allNodeIds) {
    const lNode = local?.nodes?.[id];
    const rNode = remote?.nodes?.[id];

    const inLocal  = !!lNode;
    const inRemote = !!rNode;

    let status: DiffStatus;
    if (nodeStatusMap.has(id)) {
      status = nodeStatusMap.get(id)!;
    } else if (inLocal && inRemote) {
      status =
        (lNode!.displayName !== rNode!.displayName ||
         lNode!.nodeType    !== rNode!.nodeType    ||
         JSON.stringify(lNode!.connections) !== JSON.stringify(rNode!.connections))
          ? "modified" : "unchanged";
    } else {
      status = inRemote ? "added" : "removed";
    }

    const node = rNode ?? lNode!;
    const pos  = { x: node.x, y: node.y };
    const outcomes = Object.keys(node.connections ?? {});

    if (node.nodeType === "PageNode" && pageConfigs) {
      const pageConfig = pageConfigs.get(id);
      const children = pageConfig?.nodes ?? [];
      const groupH   = diffPageGroupHeight(Math.max(children.length, 1));
      rfNodes.push({
        id,
        type: "pageGroup",
        position: { x: 0, y: 0 },
        style: { width: DIFF_PAGE_GROUP_W, height: groupH },
        data: {
          label:    node.displayName ?? "Page Node",
          nodeType: "PageNode",
          children,
          outcomes,
          diffStatus: status,
          modifiedReason: nodeModifiedReasonMap?.get(id),
          _origPos: pos,
        },
      });
      children.forEach((child, i) => {
        const childStatus = nodeStatusMap.get(child._id) ?? status;
        rfNodes.push({
          id: `${id}__child__${child._id}`,
          type: "pageChild",
          position: { x: DIFF_PAGE_GROUP_PAD, y: DIFF_PAGE_GROUP_TOP + i * (DIFF_PAGE_CHILD_H + DIFF_PAGE_CHILD_GAP) },
          parentId: id,
          extent: "parent" as const,
          draggable: false,
          style: { width: DIFF_PAGE_CHILD_W, height: DIFF_PAGE_CHILD_H },
          data: { label: child.displayName, nodeType: child.nodeType, diffStatus: childStatus },
        });
      });
    } else {
      rfNodes.push({
        id,
        type: "journeyDiffNode",
        position: { x: 0, y: 0 },
        data: {
          label:    node.displayName ?? node.nodeType ?? id.slice(0, 8),
          nodeType: node.nodeType,
          outcomes,
          diffStatus: status,
          modifiedReason: nodeModifiedReasonMap?.get(id),
          _origPos: pos,
        },
      });
    }

    // Edges from this node
    const localConns  = lNode?.connections  ?? {};
    const remoteConns = rNode?.connections  ?? {};
    const allOutcomes = new Set([
      ...Object.keys(localConns),
      ...Object.keys(remoteConns),
    ]);

    for (const outcome of allOutcomes) {
      const lTarget = localConns[outcome];
      const rTarget = remoteConns[outcome];

      let edgeStatus: DiffStatus;
      const targetId = rTarget ?? lTarget!;

      if (lTarget && rTarget) {
        edgeStatus = lTarget === rTarget ? "unchanged" : "modified";
      } else {
        edgeStatus = rTarget ? "added" : "removed";
      }

      rfEdges.push({
        id: `${id}--${outcome}`,
        source: id,
        sourceHandle: outcome,
        target: targetId,
        label: outcome === "outcome" ? undefined : outcome,

        style: makeEdgeStyle(edgeStatus, targetId),
        labelStyle: { fontSize: 9, fill: "#64748b" },
        labelBgStyle: { fill: "#f8fafc", fillOpacity: 0.9 },
        labelBgPadding: [3, 5] as [number, number],
        labelBgBorderRadius: 3,
        data: { diffStatus: edgeStatus },
      });
    }
  }

  return { nodes: rfNodes, edges: rfEdges };
}

// ── parseSingleSideGraph ──────────────────────────────────────────────────────

/**
 * Parse a single journey JSON for one side of the side-by-side view.
 * "Added" nodes don't exist on local side → show as unchanged there.
 * "Removed" nodes don't exist on remote side → show as unchanged there.
 */
export function parseSingleSideGraph(
  content: string,
  nodeStatusMap: Map<string, DiffStatus>,
  side: "local" | "remote",
  nodeModifiedReasonMap?: Map<string, "script" | "subjourney">,
  pageConfigs?: Map<string, PageNodeConfig>,
): { nodes: Node[]; edges: Edge[] } {
  const data = parseJson(content);
  if (!data) return { nodes: [], edges: [] };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // Static nodes
  for (const [id, pos] of Object.entries(data.staticNodes ?? {})) {
    const type =
      id === "startNode"     ? "startNode"   :
      id === DIFF_SUCCESS_ID ? "successNode" :
      id === DIFF_FAILURE_ID ? "failureNode" : "successNode";

    rfNodes.push({
      id,
      type,
      position: { x: pos.x, y: pos.y },
      data: { label: id, diffStatus: "unchanged" as DiffStatus },
    });
  }

  // Start edge
  if (data.entryNodeId && data.staticNodes?.["startNode"]) {
    rfEdges.push({
      id: "__start__",
      source: "startNode",
      target: data.entryNodeId,
      style: makeEdgeStyle("unchanged", data.entryNodeId),
      data: { diffStatus: "unchanged" as DiffStatus },
    });
  }

  // Regular nodes
  for (const [id, node] of Object.entries(data.nodes ?? {})) {
    let rawStatus: DiffStatus = nodeStatusMap.get(id) ?? "unchanged";

    // Normalise: "added" nodes only exist on remote; "removed" only on local
    if (side === "local"  && rawStatus === "added")   rawStatus = "unchanged";
    if (side === "remote" && rawStatus === "removed")  rawStatus = "unchanged";

    const outcomes = Object.keys(node.connections ?? {});

    if (node.nodeType === "PageNode" && pageConfigs) {
      const pageConfig = pageConfigs.get(id);
      const children = pageConfig?.nodes ?? [];
      const groupH   = diffPageGroupHeight(Math.max(children.length, 1));
      rfNodes.push({
        id,
        type: "pageGroup",
        position: { x: 0, y: 0 },
        style: { width: DIFF_PAGE_GROUP_W, height: groupH },
        data: {
          label:    node.displayName ?? "Page Node",
          nodeType: "PageNode",
          children,
          outcomes,
          diffStatus: rawStatus,
          modifiedReason: nodeModifiedReasonMap?.get(id),
        },
      });
      children.forEach((child, i) => {
        const childStatus = nodeStatusMap.get(child._id) ?? rawStatus;
        rfNodes.push({
          id: `${id}__child__${child._id}`,
          type: "pageChild",
          position: { x: DIFF_PAGE_GROUP_PAD, y: DIFF_PAGE_GROUP_TOP + i * (DIFF_PAGE_CHILD_H + DIFF_PAGE_CHILD_GAP) },
          parentId: id,
          extent: "parent" as const,
          draggable: false,
          style: { width: DIFF_PAGE_CHILD_W, height: DIFF_PAGE_CHILD_H },
          data: { label: child.displayName, nodeType: child.nodeType, diffStatus: childStatus },
        });
      });
    } else {
      rfNodes.push({
        id,
        type: "journeyDiffNode",
        position: { x: 0, y: 0 },
        data: {
          label:     node.displayName ?? node.nodeType ?? id.slice(0, 8),
          nodeType:  node.nodeType,
          outcomes,
          diffStatus: rawStatus,
          modifiedReason: nodeModifiedReasonMap?.get(id),
        },
      });
    }

    for (const [outcome, targetId] of Object.entries(node.connections ?? {})) {
      rfEdges.push({
        id: `${id}--${outcome}`,
        source: id,
        sourceHandle: outcome,
        target: targetId,
        label: outcome === "outcome" ? undefined : outcome,

        style: makeEdgeStyle("unchanged", targetId),
        labelStyle: { fontSize: 9, fill: "#64748b" },
        labelBgStyle: { fill: "#f8fafc", fillOpacity: 0.9 },
        labelBgPadding: [3, 5] as [number, number],
        labelBgBorderRadius: 3,
        data: { diffStatus: "unchanged" as DiffStatus },
      });
    }
  }

  return { nodes: rfNodes, edges: rfEdges };
}

// ── parseNodesOnlyGraph ───────────────────────────────────────────────────────

/**
 * Fallback: build a flat list of nodes from JourneyNodeInfo when no JSON content is available.
 */
export function parseNodesOnlyGraph(
  nodeInfos: Array<{ uuid: string; name: string; nodeType: string; status: DiffStatus }>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = nodeInfos.map((info) => ({
    id: info.uuid,
    type: "journeyDiffNode",
    position: { x: 0, y: 0 },
    data: {
      label:     info.name,
      nodeType:  info.nodeType,
      outcomes:  [] as string[],
      diffStatus: info.status,
    },
  }));
  return { nodes, edges: [] };
}
