"use client";

import { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";

// ── Constants (must match JourneyGraph.tsx) ───────────────────────────────────

const SUCCESS_ID = "e301438c-0bd0-429c-ab0c-66126501069a";
const FAILURE_ID = "70e691a5-1e33-4ac3-a356-e7b6d60d92e0";

const SPECIAL_NODE_BG: Partial<Record<string, string>> = {
  ScriptedDecisionNode:   "bg-violet-50",
  InnerTreeEvaluatorNode: "bg-amber-50",
};

const EXPAND_ALL = 999;
const GUIDE_W    = 16; // px per indent level

// ── Types ─────────────────────────────────────────────────────────────────────

interface JourneyNode {
  displayName?: string;
  nodeType?: string;
  connections?: Record<string, string>;
}

interface JourneyJson {
  entryNodeId?: string;
  nodes?: Record<string, JourneyNode>;
}

interface TreeNode {
  id: string;
  label: string;
  nodeType?: string;
  outcomeFromParent?: string;
  children: TreeNode[];
  isBackRef: boolean;
  isSuccess: boolean;
  isFailure: boolean;
}

// ── Tree builder ──────────────────────────────────────────────────────────────

function getLabel(id: string, nodes: Record<string, JourneyNode>): string {
  if (id === SUCCESS_ID) return "Success";
  if (id === FAILURE_ID) return "Failure";
  return nodes[id]?.displayName ?? id.slice(0, 8);
}

function buildTree(
  nodeId: string,
  nodes: Record<string, JourneyNode>,
  visited: Set<string>,
  outcomeFromParent?: string,
): TreeNode {
  const isSuccess = nodeId === SUCCESS_ID;
  const isFailure = nodeId === FAILURE_ID;

  if (!isSuccess && !isFailure && visited.has(nodeId)) {
    return {
      id: nodeId,
      label: getLabel(nodeId, nodes),
      nodeType: nodes[nodeId]?.nodeType,
      outcomeFromParent,
      children: [],
      isBackRef: true,
      isSuccess: false,
      isFailure: false,
    };
  }

  if (!isSuccess && !isFailure) visited.add(nodeId);

  const node = nodes[nodeId];
  const children =
    !isSuccess && !isFailure && node?.connections
      ? Object.entries(node.connections).map(([outcomeId, targetId]) =>
          buildTree(targetId, nodes, visited, outcomeId)
        )
      : [];

  return {
    id: nodeId,
    label: getLabel(nodeId, nodes),
    nodeType: node?.nodeType,
    outcomeFromParent,
    children,
    isBackRef: false,
    isSuccess,
    isFailure,
  };
}

function parseOutline(json: string): TreeNode | null {
  try {
    const data = JSON.parse(json) as JourneyJson;
    if (!data.entryNodeId || !data.nodes) return null;
    const entryTree = buildTree(data.entryNodeId, data.nodes, new Set());
    return {
      id: "startNode",
      label: "Start",
      nodeType: undefined,
      outcomeFromParent: undefined,
      children: [entryTree],
      isBackRef: false,
      isSuccess: false,
      isFailure: false,
    };
  } catch {
    return null;
  }
}

function getMaxDepth(node: TreeNode, depth = 0): number {
  if (node.isBackRef || node.children.length === 0) return depth;
  return Math.max(...node.children.map((c) => getMaxDepth(c, depth + 1)));
}

// ── Row component ─────────────────────────────────────────────────────────────

function TreeRow({
  node,
  depth,
  targetDepth,
  isLast,
  lineGuides,
}: {
  node: TreeNode;
  depth: number;
  targetDepth: number;
  isLast: boolean;
  // lineGuides[i] = true means draw a vertical continuation line at ancestor level i
  lineGuides: boolean[];
}) {
  const [open, setOpen] = useState(depth < targetDepth);
  const hasChildren = node.children.length > 0 && !node.isBackRef;
  const isStart     = node.id === "startNode";
  const specialBg   = node.nodeType ? (SPECIAL_NODE_BG[node.nodeType] ?? "") : "";

  useEffect(() => {
    setOpen(depth < targetDepth);
  }, [targetDepth, depth]);

  return (
    <div>
      {/* Row */}
      <div className="flex items-stretch min-h-[22px]">

        {/* Ancestor guide lines */}
        {lineGuides.map((hasLine, i) => (
          <div key={i} className="relative shrink-0" style={{ width: GUIDE_W }}>
            {hasLine && (
              <div className="absolute inset-y-0 bg-slate-200" style={{ left: GUIDE_W / 2 - 0.5, width: 1 }} />
            )}
          </div>
        ))}

        {/* Connector (├─ or └─) — not shown for root */}
        {depth > 0 && (
          <div className="relative shrink-0" style={{ width: GUIDE_W }}>
            {/* Vertical segment going up to parent */}
            <div className="absolute bg-slate-200" style={{ left: GUIDE_W / 2 - 0.5, width: 1, top: 0, bottom: "50%" }} />
            {/* Vertical segment going down to next sibling */}
            {!isLast && (
              <div className="absolute bg-slate-200" style={{ left: GUIDE_W / 2 - 0.5, width: 1, top: "50%", bottom: 0 }} />
            )}
            {/* Horizontal segment to node */}
            <div className="absolute bg-slate-200" style={{ left: GUIDE_W / 2, right: 0, top: "50%", height: 1 }} />
          </div>
        )}

        {/* Node content */}
        <div
          className={cn(
            "flex items-center gap-1.5 py-[3px] pr-2 flex-1 min-w-0 rounded-sm",
            hasChildren ? "cursor-pointer hover:bg-slate-100/80" : "cursor-default",
            !node.isBackRef && !node.isSuccess && !node.isFailure ? specialBg : "",
          )}
          onClick={() => hasChildren && setOpen((o) => !o)}
        >
          {/* Expand / collapse indicator */}
          <span className="w-3 shrink-0 text-[10px] text-slate-400 leading-none font-mono select-none">
            {hasChildren ? (open ? "−" : "+") : ""}
          </span>

          {/* Outcome badge */}
          {node.outcomeFromParent && (
            <span className="text-[9px] font-mono bg-slate-100 text-slate-500 rounded px-1 py-0.5 shrink-0 leading-none">
              {node.outcomeFromParent}
            </span>
          )}

          {/* Terminal / start colour dot */}
          {isStart        && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
          {node.isSuccess && <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />}
          {node.isFailure && <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0" />}

          {/* Label */}
          <span
            className={cn(
              "text-[11px] leading-snug truncate",
              node.isBackRef ? "text-slate-400 italic" :
              isStart        ? "text-emerald-700 font-semibold" :
              node.isSuccess ? "text-emerald-600 font-medium" :
              node.isFailure ? "text-rose-600 font-medium" :
                               "text-slate-700 font-medium",
            )}
          >
            {node.isBackRef ? `↩ ${node.label}` : node.label}
          </span>

          {/* Node type hint */}
          {node.nodeType && !node.isBackRef && !node.isSuccess && !node.isFailure && (
            <span className="text-[9px] text-slate-400 shrink-0 ml-0.5">{node.nodeType}</span>
          )}

          {/* Level badge */}
          <span className="text-[9px] font-mono text-slate-300 shrink-0">L{depth + 1}</span>
        </div>
      </div>

      {/* Children */}
      {open && node.children.map((child, i) => {
        const childIsLast  = i === node.children.length - 1;
        // Guides for the child: inherit current guides + whether THIS node has more siblings
        const childGuides  = depth === 0 ? [] : [...lineGuides, !isLast];
        return (
          <TreeRow
            key={`${child.id}-${i}`}
            node={child}
            depth={depth + 1}
            targetDepth={targetDepth}
            isLast={childIsLast}
            lineGuides={childGuides}
          />
        );
      })}
    </div>
  );
}

// ── Public export ─────────────────────────────────────────────────────────────

export function JourneyOutlineView({ json }: { json: string }) {
  const root     = useMemo(() => parseOutline(json), [json]);
  const maxDepth = useMemo(() => (root ? getMaxDepth(root) : 0), [root]);

  const [targetDepth, setTargetDepth] = useState(1);

  useEffect(() => { setTargetDepth(1); }, [root]);

  if (!root) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-slate-400">
        Unable to parse journey outline
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Level toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-200 bg-white shrink-0 flex-wrap">
        <span className="text-[10px] text-slate-400 mr-0.5">Expand:</span>

        {Array.from({ length: maxDepth }, (_, i) => i + 1).map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => setTargetDepth(level - 1)}
            className={cn(
              "text-[10px] px-2 py-0.5 rounded border transition-colors",
              targetDepth === level - 1
                ? "bg-slate-700 text-white border-slate-700"
                : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
            )}
          >
            L{level}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setTargetDepth(EXPAND_ALL)}
          className={cn(
            "text-[10px] px-2 py-0.5 rounded border transition-colors",
            targetDepth === EXPAND_ALL
              ? "bg-slate-700 text-white border-slate-700"
              : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
          )}
        >
          All
        </button>
      </div>

      {/* Tree */}
      <div className="overflow-auto flex-1 py-3 px-2">
        <TreeRow
          node={root}
          depth={0}
          targetDepth={targetDepth}
          isLast
          lineGuides={[]}
        />
      </div>
    </div>
  );
}
