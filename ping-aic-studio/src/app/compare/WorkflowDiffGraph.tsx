"use client";

import { useMemo, useEffect, useCallback, useRef, useState } from "react";
import {
  Handle,
  Position,
  MarkerType,
  type NodeProps,
  type Node,
  type Edge,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { DiffGraphCanvas } from "@/components/diff-graph/DiffGraphCanvas";
import { WorkflowOutlineView } from "@/app/configs/WorkflowOutlineView";
import { parseWorkflowData, type WorkflowData, type WorkflowStep, type WorkflowStepKind } from "@/lib/workflow-graph";
import type { FileDiff } from "@/lib/diff-types";

// ── Diff status ───────────────────────────────────────────────────────────────

type DiffStatus = "added" | "removed" | "modified" | "unchanged";

// ── Sizing ────────────────────────────────────────────────────────────────────

const NODE_W    = 180;
const NODE_H    = 64;
const CIRCLE_SZ = 44;

// ── Node components ───────────────────────────────────────────────────────────

function StartNode() {
  return (
    <div
      className="rounded-full bg-emerald-500 border-2 border-emerald-600 flex items-center justify-center shadow"
      style={{ width: CIRCLE_SZ, height: CIRCLE_SZ }}
    >
      <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
        <path d="M8 5v14l11-7z" />
      </svg>
      <Handle type="source" position={Position.Right} style={{ background: "#10b981" }} />
    </div>
  );
}

function EndNode() {
  return (
    <div
      className="rounded-full bg-slate-600 border-2 border-slate-700 flex items-center justify-center shadow"
      style={{ width: CIRCLE_SZ, height: CIRCLE_SZ }}
    >
      <div className="w-4 h-4 rounded-full border-2 border-slate-300" />
      <Handle type="target" position={Position.Left} style={{ background: "#475569" }} />
    </div>
  );
}

const DIFF_STATUS_STYLE: Record<DiffStatus, { border: string; bg: string; badge: string }> = {
  added:     { border: "border-emerald-400", bg: "bg-emerald-50",  badge: "bg-emerald-100 text-emerald-700" },
  removed:   { border: "border-red-400",     bg: "bg-red-50",      badge: "bg-red-100 text-red-700" },
  modified:  { border: "border-amber-400",   bg: "bg-amber-50",    badge: "bg-amber-100 text-amber-700" },
  unchanged: { border: "border-slate-200",   bg: "bg-white",       badge: "bg-slate-100 text-slate-500" },
};

const KIND_ICON: Record<WorkflowStepKind, React.ReactNode> = {
  approvalTask: (
    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
    </svg>
  ),
  scriptTask: (
    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
    </svg>
  ),
  exclusiveGateway: (
    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
    </svg>
  ),
};

const KIND_LABEL: Record<WorkflowStepKind, string> = {
  approvalTask:     "Approval",
  scriptTask:       "Script",
  exclusiveGateway: "Gateway",
};

function DiffStepNode({ data }: NodeProps) {
  const d = data as {
    displayName: string;
    kind: WorkflowStepKind;
    diffStatus: DiffStatus;
    isFocused?: boolean;
    isCompact?: boolean;
    isSearchMatch?: boolean;
  };
  const diff = DIFF_STATUS_STYLE[d.diffStatus] ?? DIFF_STATUS_STYLE.unchanged;
  const w = d.isCompact ? 120 : NODE_W;
  const h = d.isCompact ? 44  : NODE_H;

  return (
    <div
      className={cn(
        "border rounded-lg shadow-sm relative",
        diff.border,
        diff.bg,
        d.isFocused
          ? "ring-4 ring-red-500 ring-offset-2"
          : d.isSearchMatch && "ring-2 ring-sky-500",
      )}
      style={{ width: w, height: h }}
    >
      <Handle type="target" position={Position.Left}  style={{ background: "#94a3b8" }} />
      <div className={cn("h-full flex flex-col justify-between", d.isCompact ? "px-1.5 py-1" : "px-2.5 py-2")}>
        <div className="flex items-start gap-1.5">
          {KIND_ICON[d.kind]}
          <span className={cn("font-medium leading-tight text-slate-700 line-clamp-2", d.isCompact ? "text-[9px]" : "text-[11px]")}>
            {d.displayName}
          </span>
        </div>
        {!d.isCompact && (
          <div className="flex items-center gap-1">
            <span className={cn("text-[9px] font-bold px-1 rounded", diff.badge)}>
              {d.diffStatus === "unchanged" ? KIND_LABEL[d.kind] : d.diffStatus}
            </span>
            {d.diffStatus === "unchanged" && (
              <span className="text-[9px] text-slate-400">{KIND_LABEL[d.kind]}</span>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "#94a3b8" }} />
    </div>
  );
}

const NODE_TYPES = {
  wfDiffStart: StartNode,
  wfDiffEnd:   EndNode,
  wfDiffStep:  DiffStepNode,
} as const;

// ── Diff graph builder ────────────────────────────────────────────────────────

interface DiffStep extends WorkflowStep {
  diffStatus: DiffStatus;
}

interface WorkflowDiffData {
  startX: number; startY: number;
  endX: number;   endY: number;
  startConnection: string;
  steps: DiffStep[];
}

function buildDiffData(
  localWorkflow:  WorkflowData | null,
  remoteWorkflow: WorkflowData | null,
): WorkflowDiffData {
  // Use remote for positions when available, else local
  const base = remoteWorkflow ?? localWorkflow;
  if (!base) return { startX: 70, startY: 225, endX: 2000, endY: 225, startConnection: "", steps: [] };

  const localMap  = new Map<string, WorkflowStep>(localWorkflow?.steps.map((s) => [s.id, s]) ?? []);
  const remoteMap = new Map<string, WorkflowStep>(remoteWorkflow?.steps.map((s) => [s.id, s]) ?? []);

  const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const steps: DiffStep[] = [];

  for (const id of allIds) {
    const local  = localMap.get(id);
    const remote = remoteMap.get(id);
    let diffStatus: DiffStatus;
    if      (!local)  diffStatus = "added";
    else if (!remote) diffStatus = "removed";
    else              diffStatus = "unchanged"; // position/metadata diffs treated as unchanged

    const step = remote ?? local!;
    steps.push({ ...step, diffStatus });
  }

  return {
    startX:          base.startX,
    startY:          base.startY,
    endX:            base.endX,
    endY:            base.endY,
    startConnection: base.startConnection,
    steps,
  };
}

function buildGraph(diffData: WorkflowDiffData, focusedId: string | null): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: "startNode", type: "wfDiffStart", position: { x: diffData.startX, y: diffData.startY }, data: {} },
    { id: "endNode",   type: "wfDiffEnd",   position: { x: diffData.endX,   y: diffData.endY   }, data: {} },
  ];
  const edges: Edge[] = [];

  for (const step of diffData.steps) {
    nodes.push({
      id:       step.id,
      type:     "wfDiffStep",
      position: { x: step.x, y: step.y },
      data:     { displayName: step.displayName, kind: step.kind, diffStatus: step.diffStatus, isFocused: step.id === focusedId },
    });
  }

  if (diffData.startConnection) {
    edges.push({
      id:        `start->${diffData.startConnection}`,
      source:    "startNode",
      target:    diffData.startConnection,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
      style:     { stroke: "#94a3b8" },
    });
  }

  for (const step of diffData.steps) {
    for (const ns of step.nextStep) {
      const target = ns.step || "endNode";
      const label  = ns.condition ? `${ns.outcome} [${ns.condition}]` : ns.outcome;
      const edgeColor =
        step.diffStatus === "added"   ? "#34d399" :
        step.diffStatus === "removed" ? "#f87171" :
        step.diffStatus === "modified"? "#fbbf24" : "#94a3b8";
      edges.push({
        id:             `${step.id}->${target}::${ns.outcome}`,
        source:         step.id,
        target,
        label,
        labelStyle:     { fontSize: 9, fill: "#64748b" },
        labelBgStyle:   { fill: "rgba(255,255,255,0.85)", fillOpacity: 1 },
        labelBgPadding: [3, 2] as [number, number],
        markerEnd:      { type: MarkerType.ArrowClosed, color: edgeColor },
        style:          { stroke: edgeColor },
      });
    }
  }

  return { nodes, edges };
}

// ── Side panel ────────────────────────────────────────────────────────────────

function StepDetailPanel({
  step,
  localContent,
  remoteContent,
  sourceLabel,
  targetLabel,
  onClose,
}: {
  step: DiffStep;
  localContent?: string;
  remoteContent?: string;
  sourceLabel: string;
  targetLabel: string;
  onClose: () => void;
}) {
  const diff = DIFF_STATUS_STYLE[step.diffStatus];
  return (
    <div className="w-72 shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
        <span className="text-xs font-semibold text-slate-700 flex-1 truncate">{step.displayName}</span>
        <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded", diff.badge)}>{step.diffStatus}</span>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {/* Meta */}
      <div className="px-3 py-2 space-y-1 border-b border-slate-100 shrink-0">
        <div className="flex gap-2 text-[10px]">
          <span className="text-slate-400 w-14 shrink-0">ID</span>
          <span className="text-slate-600 font-mono truncate">{step.id}</span>
        </div>
        <div className="flex gap-2 text-[10px]">
          <span className="text-slate-400 w-14 shrink-0">Type</span>
          <span className="text-slate-600">{KIND_LABEL[step.kind]}</span>
        </div>
        {step.nextStep.length > 0 && (
          <div className="flex gap-2 text-[10px]">
            <span className="text-slate-400 w-14 shrink-0 pt-0.5">Outcomes</span>
            <div className="space-y-0.5">
              {step.nextStep.map((ns, i) => (
                <div key={i} className="text-slate-600">
                  <span className="font-medium">{ns.outcome}</span>
                  {ns.condition && <span className="text-slate-400"> [{ns.condition}]</span>}
                  <span className="text-slate-400"> → {ns.step}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Content diff summary */}
      {(localContent || remoteContent) && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {[
            { label: sourceLabel, content: localContent,  color: "text-red-500" },
            { label: targetLabel, content: remoteContent, color: "text-emerald-600" },
          ].map(({ label, content, color }) => content ? (
            <div key={label} className="border-b border-slate-100 last:border-0">
              <p className={cn("text-[9px] font-bold px-3 pt-2 pb-1 uppercase tracking-wide", color)}>{label}</p>
              <pre className="text-[10px] font-mono leading-relaxed px-3 pb-2 overflow-x-auto text-slate-600 whitespace-pre-wrap break-all">
                {content.length > 800 ? content.slice(0, 800) + "\n…" : content}
              </pre>
            </div>
          ) : null)}
        </div>
      )}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  const items: { color: string; label: string }[] = [
    { color: "bg-emerald-400", label: "Added" },
    { color: "bg-red-400",     label: "Removed" },
    { color: "bg-amber-400",   label: "Modified" },
    { color: "bg-slate-200",   label: "Unchanged" },
  ];
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-slate-200 bg-slate-50 shrink-0">
      {items.map(({ color, label }) => (
        <div key={label} className="flex items-center gap-1">
          <span className={cn("w-2.5 h-2.5 rounded-sm", color)} />
          <span className="text-[10px] text-slate-500">{label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export interface WorkflowDiffGraphModalProps {
  workflowName: string;
  workflowFiles: FileDiff[];
  sourceLabel: string;
  targetLabel: string;
  onClose: () => void;
}

export function WorkflowDiffGraphModal({
  workflowName,
  workflowFiles,
  sourceLabel,
  targetLabel,
  onClose,
}: WorkflowDiffGraphModalProps) {
  const [activeStep, setActiveStep] = useState<{ step: DiffStep; local?: string; remote?: string } | null>(null);
  const [viewMode,      setViewMode]      = useState<"merged" | "side-by-side">("merged");
  const [hideUnchanged, setHideUnchanged] = useState(false);
  const [isCompact,     setIsCompact]     = useState(false);
  const [syncViewports, setSyncViewports] = useState(true);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [fitKey,        setFitKey]        = useState(0);
  const [leftViewport,  setLeftViewport]  = useState<Viewport | null>(null);
  const [rightViewport, setRightViewport] = useState<Viewport | null>(null);
  const [displayView,   setDisplayView]   = useState<"graph" | "outline">("graph");
  const [zoomToNodeId,  setZoomToNodeId]  = useState<string | null>(null);
  const syncingRef = useRef(false);

  const handleLeftMove = useCallback((vp: Viewport) => {
    if (syncingRef.current) return;
    if (!syncViewports) return;
    syncingRef.current = true;
    setRightViewport(vp);
    queueMicrotask(() => { syncingRef.current = false; });
  }, [syncViewports]);

  const handleRightMove = useCallback((vp: Viewport) => {
    if (syncingRef.current) return;
    if (!syncViewports) return;
    syncingRef.current = true;
    setLeftViewport(vp);
    queueMicrotask(() => { syncingRef.current = false; });
  }, [syncViewports]);

  // Parse local and remote workflows from the file diffs
  const { localWorkflow, remoteWorkflow } = useMemo(() => {
    // Find top-level JSON (has staticNodes)
    function isTopLevel(content: string) {
      try { return "staticNodes" in (JSON.parse(content) as Record<string, unknown>); }
      catch { return false; }
    }
    function parseWf(getContent: (f: FileDiff) => string | undefined) {
      const topFile = workflowFiles.find((f) => {
        const c = getContent(f);
        return c ? isTopLevel(c) : false;
      });
      if (!topFile) return null;
      const topContent = getContent(topFile)!;
      const stepJsons = workflowFiles
        .filter((f) => f !== topFile)
        .map((f) => getContent(f))
        .filter((c): c is string => !!c);
      return parseWorkflowData(topContent, stepJsons);
    }
    return {
      localWorkflow:  parseWf((f) => f.localContent),
      remoteWorkflow: parseWf((f) => f.remoteContent),
    };
  }, [workflowFiles]);

  const diffData = useMemo(
    () => buildDiffData(localWorkflow, remoteWorkflow),
    [localWorkflow, remoteWorkflow],
  );

  // Filter diffData by side. Modified is currently not produced by buildDiffData;
  // if it becomes produced later, it should appear on both sides.
  const leftDiffData = useMemo(() => ({
    ...diffData,
    steps: diffData.steps.filter((s) => s.diffStatus !== "added"),
  }), [diffData]);
  const rightDiffData = useMemo(() => ({
    ...diffData,
    steps: diffData.steps.filter((s) => s.diffStatus !== "removed"),
  }), [diffData]);

  const mergedGraph = useMemo(() => buildGraph(diffData,      activeStep?.step.id ?? null), [diffData,      activeStep]);
  const leftGraph   = useMemo(() => buildGraph(leftDiffData,  activeStep?.step.id ?? null), [leftDiffData,  activeStep]);
  const rightGraph  = useMemo(() => buildGraph(rightDiffData, activeStep?.step.id ?? null), [rightDiffData, activeStep]);

  // Build a map of stepId → FileDiff for the side panel content
  const stepFileDiffMap = useMemo(() => {
    const m = new Map<string, FileDiff>();
    for (const f of workflowFiles) {
      // Step files: try to get step ID from JSON content
      const content = f.localContent ?? f.remoteContent;
      if (!content) continue;
      try {
        const json = JSON.parse(content) as { name?: string };
        if (json.name && !isNaN(parseInt(json.name[0], 16))) continue; // skip non-step ids
        if (json.name) m.set(json.name, f);
      } catch { /* skip */ }
    }
    return m;
  }, [workflowFiles]);

  const handleNodeActivate = useCallback((nodeId: string | null) => {
    if (!nodeId) { setActiveStep(null); return; }
    const step = diffData.steps.find((s) => s.id === nodeId);
    const fd   = stepFileDiffMap.get(nodeId);
    if (step) setActiveStep({ step, local: fd?.localContent, remote: fd?.remoteContent });
  }, [diffData.steps, stepFileDiffMap]);

  // Keyboard close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const stats = useMemo(() => ({
    added:    diffData.steps.filter((s) => s.diffStatus === "added").length,
    removed:  diffData.steps.filter((s) => s.diffStatus === "removed").length,
    modified: diffData.steps.filter((s) => s.diffStatus === "modified").length,
  }), [diffData.steps]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-800 truncate">{workflowName}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{sourceLabel} → {targetLabel}</p>
          </div>
          {/* Diff badges */}
          <div className="flex items-center gap-1.5 text-[10px] font-mono shrink-0">
            {stats.added    > 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{stats.added} added</span>}
            {stats.modified > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{stats.modified} modified</span>}
            {stats.removed  > 0 && <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700">{stats.removed} removed</span>}
          </div>
          <div className="flex rounded border border-slate-300 overflow-hidden text-[11px] shrink-0">
            {(["graph", "outline"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setDisplayView(v)}
                className={cn(
                  "px-3 py-1 transition-colors capitalize",
                  displayView === v ? "bg-slate-600 text-white" : "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          {displayView === "graph" && (
            <>
              <div className="flex rounded border border-slate-300 overflow-hidden text-[11px] shrink-0">
                {(["merged", "side-by-side"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setViewMode(m)}
                    className={cn(
                      "px-3 py-1 transition-colors capitalize",
                      viewMode === m ? "bg-slate-600 text-white" : "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
                    )}
                  >
                    {m === "side-by-side" ? "Side by side" : "Merged"}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setHideUnchanged((v) => !v)}
                title="Hide unchanged steps"
                className={cn(
                  "px-2.5 py-1 text-[11px] rounded border transition-colors shrink-0",
                  hideUnchanged ? "bg-sky-600 text-white border-sky-600" : "text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400",
                )}
              >
                Hide unchanged
              </button>
              <button
                type="button"
                onClick={() => setIsCompact((v) => !v)}
                title={isCompact ? "Switch to normal layout" : "Switch to compact layout"}
                className={cn(
                  "px-2.5 py-1 text-[11px] rounded border transition-colors shrink-0",
                  isCompact ? "bg-sky-600 text-white border-sky-600" : "text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400",
                )}
              >
                Compact
              </button>
              {viewMode === "side-by-side" && (
                <button
                  type="button"
                  onClick={() => {
                    setSyncViewports((v) => {
                      const next = !v;
                      if (!next) { setLeftViewport(null); setRightViewport(null); }
                      return next;
                    });
                  }}
                  title="Sync viewports between panels"
                  className={cn(
                    "px-2.5 py-1 text-[11px] rounded border transition-colors shrink-0",
                    syncViewports ? "bg-sky-600 text-white border-sky-600" : "text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400",
                  )}
                >
                  Sync viewports
                </button>
              )}
              <button
                type="button"
                onClick={() => setFitKey((k) => k + 1)}
                title="Fit all steps to view"
                className="px-2.5 py-1 text-[11px] rounded border text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400 shrink-0"
              >
                Fit
              </button>
              <div className="flex items-center gap-1 shrink-0 relative">
                <input
                  type="text"
                  placeholder="Search steps…"
                  aria-label="Search steps"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-40 pl-2 pr-6 py-1 text-[11px] rounded border border-slate-300 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    title="Clear search"
                    aria-label="Clear search"
                    className="absolute right-1 text-slate-400 hover:text-slate-600"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <Legend />

        {/* Body */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Graph area */}
          {displayView === "outline" ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <WorkflowOutlineView
                steps={diffData.steps}
                onNavigate={(id) => {
                  setZoomToNodeId(null);
                  setDisplayView("graph");
                  requestAnimationFrame(() => setZoomToNodeId(id));
                }}
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex overflow-hidden bg-slate-50">
              {viewMode === "merged" ? (
                <DiffGraphCanvas
                  baseNodes={mergedGraph.nodes}
                  baseEdges={mergedGraph.edges}
                  nodeTypes={NODE_TYPES}
                  hideUnchanged={hideUnchanged}
                  isCompact={isCompact}
                  fitKey={fitKey}
                  externalViewport={null}
                  onViewportChange={() => {}}
                  onNodeActivate={handleNodeActivate}
                  searchQuery={searchQuery}
                  flashNodeId={activeStep?.step.id ?? null}
                  zoomToNodeId={zoomToNodeId}
                  onPaneClearFocus={() => setActiveStep(null)}
                />
              ) : (
                <>
                  <div className="flex-1 min-w-0 relative border-r border-slate-200">
                    <span className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-white/90 text-slate-600 text-[10px] px-2 py-1 rounded border border-slate-200 shadow-sm pointer-events-none">
                      {sourceLabel}
                    </span>
                    <DiffGraphCanvas
                      baseNodes={leftGraph.nodes}
                      baseEdges={leftGraph.edges}
                      nodeTypes={NODE_TYPES}
                      hideUnchanged={hideUnchanged}
                      isCompact={isCompact}
                      fitKey={fitKey}
                      externalViewport={leftViewport}
                      onViewportChange={handleLeftMove}
                      onNodeActivate={handleNodeActivate}
                      searchQuery={searchQuery}
                      flashNodeId={activeStep?.step.id ?? null}
                      zoomToNodeId={zoomToNodeId}
                      onPaneClearFocus={() => setActiveStep(null)}
                    />
                  </div>
                  <div className="flex-1 min-w-0 relative">
                    <span className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-white/90 text-slate-600 text-[10px] px-2 py-1 rounded border border-slate-200 shadow-sm pointer-events-none">
                      {targetLabel}
                    </span>
                    <DiffGraphCanvas
                      baseNodes={rightGraph.nodes}
                      baseEdges={rightGraph.edges}
                      nodeTypes={NODE_TYPES}
                      hideUnchanged={hideUnchanged}
                      isCompact={isCompact}
                      fitKey={fitKey}
                      externalViewport={rightViewport}
                      onViewportChange={handleRightMove}
                      onNodeActivate={handleNodeActivate}
                      searchQuery={searchQuery}
                      flashNodeId={activeStep?.step.id ?? null}
                      zoomToNodeId={zoomToNodeId}
                      onPaneClearFocus={() => setActiveStep(null)}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Side panel */}
          {activeStep && (
            <StepDetailPanel
              step={activeStep.step}
              localContent={activeStep.local}
              remoteContent={activeStep.remote}
              sourceLabel={sourceLabel}
              targetLabel={targetLabel}
              onClose={() => setActiveStep(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
