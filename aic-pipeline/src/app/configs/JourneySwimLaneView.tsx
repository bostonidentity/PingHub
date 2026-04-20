"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const SUCCESS_ID = "e301438c-0bd0-429c-ab0c-66126501069a";
const FAILURE_ID = "70e691a5-1e33-4ac3-a356-e7b6d60d92e0";

const TYPE_CARD: Partial<Record<string, string>> = {
  ScriptedDecisionNode:   "bg-violet-50 border-violet-200",
  InnerTreeEvaluatorNode: "bg-amber-50  border-amber-200",
  PageNode:               "bg-indigo-50 border-indigo-200",
};

const TYPE_BADGE: Partial<Record<string, string>> = {
  ScriptedDecisionNode:   "bg-violet-100 text-violet-700",
  InnerTreeEvaluatorNode: "bg-amber-100  text-amber-700",
  PageNode:               "bg-indigo-100 text-indigo-700",
};
const TYPE_BADGE_DEFAULT = "bg-slate-100 text-slate-500";

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

interface LaneNode {
  id: string;
  label: string;
  nodeType?: string;
  isStart?: boolean;
  isSuccess?: boolean;
  isFailure?: boolean;
}

// ── BFS parser ────────────────────────────────────────────────────────────────

function parseSwimLane(json: string): LaneNode[][] {
  try {
    const data = JSON.parse(json) as JourneyJson;
    if (!data.entryNodeId || !data.nodes) return [];

    const nodes = data.nodes;
    const depths = new Map<string, number>();

    // BFS — first visit = min depth
    const queue: string[] = [data.entryNodeId];
    depths.set(data.entryNodeId, 1); // Phase 1 (Start is Phase 0)

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const depth = depths.get(nodeId)!;
      const node = nodes[nodeId];
      if (!node?.connections) continue;

      for (const targetId of Object.values(node.connections)) {
        if (targetId === SUCCESS_ID || targetId === FAILURE_ID) {
          // keep max depth for terminals so they sit at the rightmost lane
          const prev = depths.get(targetId) ?? 0;
          if (depth + 1 > prev) depths.set(targetId, depth + 1);
          continue;
        }
        if (!depths.has(targetId)) {
          depths.set(targetId, depth + 1);
          queue.push(targetId);
        }
      }
    }

    // Put terminals at the same last lane
    const regularMax = Math.max(
      1,
      ...[...depths.entries()]
        .filter(([id]) => id !== SUCCESS_ID && id !== FAILURE_ID)
        .map(([, d]) => d),
    );
    const terminalDepth = Math.max(
      regularMax + 1,
      depths.get(SUCCESS_ID) ?? 0,
      depths.get(FAILURE_ID) ?? 0,
    );
    if (depths.has(SUCCESS_ID)) depths.set(SUCCESS_ID, terminalDepth);
    if (depths.has(FAILURE_ID)) depths.set(FAILURE_ID, terminalDepth);

    const maxDepth = Math.max(...depths.values());
    const lanes: LaneNode[][] = Array.from({ length: maxDepth + 1 }, () => []);

    // Lane 0 — Start
    lanes[0].push({ id: "startNode", label: "Start", isStart: true });

    // Regular nodes
    for (const [id, node] of Object.entries(nodes)) {
      const d = depths.get(id);
      if (d === undefined) continue;
      lanes[d].push({
        id,
        label: node.displayName ?? id.slice(0, 8),
        nodeType: node.nodeType,
      });
    }

    // Terminals
    if (depths.has(SUCCESS_ID)) lanes[terminalDepth].push({ id: SUCCESS_ID, label: "Success", isSuccess: true });
    if (depths.has(FAILURE_ID)) lanes[terminalDepth].push({ id: FAILURE_ID, label: "Failure", isFailure: true });

    return lanes;
  } catch {
    return [];
  }
}

// ── Node card ─────────────────────────────────────────────────────────────────

function NodeCard({ node }: { node: LaneNode }) {
  if (node.isStart) {
    return (
      <div className="flex items-center gap-1.5 rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 shadow-sm">
        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
        <span className="text-[11px] font-semibold text-emerald-700">{node.label}</span>
      </div>
    );
  }

  if (node.isSuccess) {
    return (
      <div className="flex items-center gap-1.5 rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 shadow-sm">
        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
        <span className="text-[11px] font-medium text-emerald-600">{node.label}</span>
      </div>
    );
  }

  if (node.isFailure) {
    return (
      <div className="flex items-center gap-1.5 rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 shadow-sm">
        <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0" />
        <span className="text-[11px] font-medium text-rose-600">{node.label}</span>
      </div>
    );
  }

  return (
    <div className={cn(
      "rounded border px-2.5 py-1.5 shadow-sm bg-white border-slate-200",
      TYPE_CARD[node.nodeType ?? ""] ?? "",
    )}>
      <p className="text-[11px] font-medium text-slate-700 leading-snug mb-1">{node.label}</p>
      {node.nodeType && (
        <span className={cn(
          "text-[9px] font-medium rounded px-1.5 py-0.5 leading-none",
          TYPE_BADGE[node.nodeType] ?? TYPE_BADGE_DEFAULT,
        )}>
          {node.nodeType}
        </span>
      )}
    </div>
  );
}

// ── Public export ─────────────────────────────────────────────────────────────

export function JourneySwimLaneView({ json }: { json: string }) {
  const lanes = useMemo(() => parseSwimLane(json), [json]);

  if (lanes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-slate-400">
        Unable to parse journey phases
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="flex items-stretch gap-0 min-h-full px-4 py-4 w-max">
        {lanes.map((lane, laneIdx) => {
          const isTerminal = laneIdx === lanes.length - 1;
          const isStart    = laneIdx === 0;
          const label      = isStart ? "Start" : isTerminal ? "End" : `Phase ${laneIdx}`;

          return (
            <div key={laneIdx} className="flex items-center">
              {/* Lane column */}
              <div className="flex flex-col w-44">
                {/* Lane header */}
                <div className={cn(
                  "text-center mb-2 pb-1.5 border-b",
                  isStart || isTerminal ? "border-slate-200" : "border-slate-200",
                )}>
                  <span className={cn(
                    "text-[10px] font-semibold uppercase tracking-wider",
                    isStart    ? "text-emerald-600" :
                    isTerminal ? "text-slate-400" :
                                 "text-slate-400",
                  )}>
                    {label}
                  </span>
                  <span className="ml-1.5 text-[9px] text-slate-300">
                    {lane.length} node{lane.length !== 1 ? "s" : ""}
                  </span>
                </div>

                {/* Cards */}
                <div className="flex flex-col gap-1.5">
                  {lane.map((node) => (
                    <NodeCard key={node.id} node={node} />
                  ))}
                </div>
              </div>

              {/* Arrow between lanes */}
              {laneIdx < lanes.length - 1 && (
                <div className="flex items-center justify-center w-8 shrink-0 self-start mt-6">
                  <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
