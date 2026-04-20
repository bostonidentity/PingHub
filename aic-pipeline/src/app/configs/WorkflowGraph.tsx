"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  useReactFlow,
  useNodesState,
  useEdgesState,
  MarkerType,
  type NodeProps,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { cn } from "@/lib/utils";
import { highlightJs, ScriptOverlay } from "./ScriptOverlay";
import { withLineNumbers } from "@/lib/highlight";
import { parseWorkflowData, type WorkflowData, type WorkflowStep, type WorkflowStepKind } from "@/lib/workflow-graph";
import type { ViewableFile } from "@/app/api/push/item/route";

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_W    = 180;
const NODE_H    = 64;
const CIRCLE_SZ = 44;

// ── Node styling helpers ──────────────────────────────────────────────────────

const KIND_STYLE: Record<WorkflowStepKind, { border: string; bg: string; badge: string; selectedBorder: string; label: string }> = {
  approvalTask:     { border: "border-blue-200",   bg: "bg-blue-50",   badge: "bg-blue-100 text-blue-700",   selectedBorder: "border-blue-500",   label: "Approval" },
  scriptTask:       { border: "border-violet-200", bg: "bg-violet-50", badge: "bg-violet-100 text-violet-700", selectedBorder: "border-violet-500", label: "Script" },
  exclusiveGateway: { border: "border-amber-200",  bg: "bg-amber-50",  badge: "bg-amber-100 text-amber-700",  selectedBorder: "border-amber-500",  label: "Gateway" },
};

const KIND_ICON: Record<WorkflowStepKind, React.ReactNode> = {
  approvalTask: (
    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
    </svg>
  ),
  scriptTask: (
    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
    </svg>
  ),
  exclusiveGateway: (
    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
    </svg>
  ),
};

// ── Custom nodes ──────────────────────────────────────────────────────────────

function StartNode() {
  return (
    <div className="rounded-full bg-emerald-500 border-2 border-emerald-600 flex items-center justify-center shadow"
      style={{ width: CIRCLE_SZ, height: CIRCLE_SZ }}>
      <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
      <Handle type="source" position={Position.Right} style={{ background: "#10b981" }} />
    </div>
  );
}

function EndNode() {
  return (
    <div className="rounded-full bg-slate-600 border-2 border-slate-700 flex items-center justify-center shadow"
      style={{ width: CIRCLE_SZ, height: CIRCLE_SZ }}>
      <div className="w-4 h-4 rounded-full border-2 border-slate-300" />
      <Handle type="target" position={Position.Left} style={{ background: "#475569" }} />
    </div>
  );
}

function StepNode({ data }: NodeProps) {
  const d       = data as { displayName: string; kind: WorkflowStepKind; isSelected?: boolean; isSearchMatch?: boolean };
  const styles  = KIND_STYLE[d.kind] ?? KIND_STYLE.scriptTask;
  const border  = d.isSelected ? styles.selectedBorder : styles.border;
  const borderW = d.isSelected ? "border-2" : "border";
  return (
    <div
      className={cn("rounded-lg shadow-sm relative", borderW, border, styles.bg,
        d.isSearchMatch && "ring-2 ring-amber-400 ring-offset-1")}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle type="target" position={Position.Left}  style={{ background: "#94a3b8" }} />
      <div className="px-2.5 py-2 h-full flex flex-col justify-between">
        <div className="flex items-start gap-1.5">
          {KIND_ICON[d.kind]}
          <span className="text-[11px] font-medium leading-tight text-slate-700 line-clamp-2">{d.displayName}</span>
        </div>
        <span className={cn("self-start text-[9px] font-bold px-1 rounded", styles.badge)}>{styles.label}</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "#94a3b8" }} />
    </div>
  );
}

const NODE_TYPES = {
  wfStart: StartNode,
  wfEnd:   EndNode,
  wfStep:  StepNode,
} as const;

// ── Graph builder ─────────────────────────────────────────────────────────────

function buildGraph(workflow: WorkflowData): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: "startNode", type: "wfStart", position: { x: workflow.startX, y: workflow.startY }, data: {} },
    { id: "endNode",   type: "wfEnd",   position: { x: workflow.endX,   y: workflow.endY   }, data: {} },
  ];
  const edges: Edge[] = [];

  for (const step of workflow.steps) {
    nodes.push({
      id: step.id, type: "wfStep",
      position: { x: step.x, y: step.y },
      data: { displayName: step.displayName, kind: step.kind },
    });
  }

  if (workflow.startConnection) {
    edges.push({
      id: `start->${workflow.startConnection}`, source: "startNode", target: workflow.startConnection,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" }, style: { stroke: "#94a3b8" },
    });
  }

  for (const step of workflow.steps) {
    for (const ns of step.nextStep) {
      const target = ns.step || "endNode";
      const label  = ns.condition ? `${ns.outcome} [${ns.condition}]` : ns.outcome;
      edges.push({
        id: `${step.id}->${target}::${ns.outcome}`,
        source: step.id, target, label,
        labelStyle:     { fontSize: 9, fill: "#64748b" },
        labelBgStyle:   { fill: "rgba(255,255,255,0.9)", fillOpacity: 1 },
        labelBgPadding: [3, 2] as [number, number],
        markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
        style:     { stroke: "#94a3b8", strokeWidth: 1.5 },
      });
    }
  }

  return { nodes, edges };
}

// ── Dagre layout (compact mode) ───────────────────────────────────────────────

function applyDagreLayout(nodes: Node[], edges: Edge[], compact = false): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph(compact
    ? { rankdir: "LR", nodesep: 25, ranksep: 60,  marginx: 24, marginy: 24 }
    : { rankdir: "LR", nodesep: 60, ranksep: 160, marginx: 40, marginy: 40 },
  );
  nodes.forEach((n) => {
    const isCircle = n.type === "wfStart" || n.type === "wfEnd";
    g.setNode(n.id, { width: isCircle ? CIRCLE_SZ : NODE_W, height: isCircle ? CIRCLE_SZ : NODE_H });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    if (!pos) return n;
    const isCircle = n.type === "wfStart" || n.type === "wfEnd";
    const w = isCircle ? CIRCLE_SZ : NODE_W;
    const h = isCircle ? CIRCLE_SZ : NODE_H;
    return { ...n, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
  });
}

// ── Path tracing helper ───────────────────────────────────────────────────────

function getConnected(nodeId: string, edges: Edge[]): Set<string> {
  const connected = new Set<string>([nodeId]);
  for (const e of edges) {
    if (e.source === nodeId) connected.add(e.target);
    if (e.target === nodeId) connected.add(e.source);
  }
  return connected;
}

// ── PropertyValue (recursive JSON tree) ──────────────────────────────────────

function PropertyValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (value === null || value === undefined) return <span className="text-slate-400 italic text-[10px]">null</span>;
  if (typeof value === "boolean") return <span className={cn("text-[10px] font-mono font-medium", value ? "text-emerald-600" : "text-rose-500")}>{String(value)}</span>;
  if (typeof value === "number") return <span className="text-[10px] font-mono text-amber-700">{value}</span>;
  if (typeof value === "string") return <span className="text-[10px] font-mono text-slate-700 break-all">{value}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400 italic text-[10px]">[]</span>;
    return (
      <div>
        <button type="button" onClick={() => setExpanded((e) => !e)} className="text-[10px] text-sky-600 hover:text-sky-800 font-mono">
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
        <button type="button" onClick={() => setExpanded((e) => !e)} className="text-[10px] text-sky-600 hover:text-sky-800 font-mono">
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

const CONFIG_SKIP = new Set(["name", "displayName", "type"]);

function PropertyTable({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config).filter(([k]) => !CONFIG_SKIP.has(k));
  if (entries.length === 0) return <p className="text-[11px] text-slate-400">No additional properties</p>;
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

// ── Step drawer ───────────────────────────────────────────────────────────────

function StepDrawer({
  step,
  stepFile,
  scriptFile,
  open,
  onClose,
}: {
  step: WorkflowStep | null;
  stepFile: ViewableFile | undefined;
  scriptFile: ViewableFile | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"config" | "script">("config");
  const [scriptFullscreen, setScriptFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setTab("config"); }, [step?.id]);

  const config = useMemo(() => {
    if (!stepFile) return null;
    try { return JSON.parse(stepFile.content) as Record<string, unknown>; }
    catch { return null; }
  }, [stepFile]);

  const scriptContent = scriptFile?.content ?? null;
  const scriptHighlighted = useMemo(
    () => (scriptContent ? withLineNumbers(highlightJs(scriptContent)) : null),
    [scriptContent],
  );

  const hasScript = !!scriptFile;
  const styles = step ? (KIND_STYLE[step.kind] ?? KIND_STYLE.scriptTask) : null;

  return (
    <>
      {scriptFullscreen && scriptContent && (
        <ScriptOverlay name={scriptFile?.name ?? "script"} content={scriptContent} onClose={() => setScriptFullscreen(false)} />
      )}

      <div className={cn(
        "absolute top-0 right-0 h-full w-72 bg-white border-l border-slate-200 shadow-2xl z-10",
        "flex flex-col transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "translate-x-full",
      )}>
        {step && (
          <>
            {/* Header */}
            <div className="flex items-start gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-800 leading-snug break-words">{step.displayName}</p>
                {styles && (
                  <span className={cn("inline-block mt-1.5 text-[10px] font-medium rounded px-1.5 py-0.5 border",
                    step.kind === "approvalTask"     ? "text-blue-700 bg-blue-50 border-blue-200" :
                    step.kind === "exclusiveGateway" ? "text-amber-700 bg-amber-50 border-amber-200" :
                                                      "text-violet-700 bg-violet-50 border-violet-200"
                  )}>
                    {styles.label}
                  </span>
                )}
              </div>
              <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0 mt-0.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Tab bar — only when script is available */}
            {hasScript && (
              <div className="flex border-b border-slate-200 bg-white shrink-0">
                {(["config", "script"] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setTab(t)}
                    className={cn(
                      "flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2",
                      tab === t ? "border-sky-500 text-sky-700" : "border-transparent text-slate-500 hover:text-slate-700",
                    )}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto min-h-0">
              {/* Config tab */}
              {tab === "config" && (
                <>
                  {/* Outcomes / nextStep */}
                  {step.nextStep.length > 0 && (
                    <div className="px-4 py-3 border-b border-slate-100">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Outcomes</p>
                      <div className="space-y-2">
                        {step.nextStep.map((ns, i) => (
                          <div key={i} className="flex items-start gap-2 min-w-0">
                            <span className="text-[10px] font-mono bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 shrink-0">{ns.outcome}</span>
                            <svg className="w-3 h-3 text-slate-300 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                            <div className="min-w-0">
                              <span className="text-[11px] text-slate-700 truncate block">{ns.step}</span>
                              {ns.condition && <span className="text-[10px] text-slate-400 font-mono">[{ns.condition}]</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Configuration */}
                  <div className="px-4 py-3">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Configuration</p>
                    {config ? <PropertyTable config={config} /> : <p className="text-[11px] text-slate-400">No configuration available</p>}
                  </div>
                </>
              )}

              {/* Script tab */}
              {tab === "script" && (
                <div className="flex flex-col h-full">
                  {!scriptContent ? (
                    <p className="px-4 py-3 text-[11px] text-slate-400">No script content found</p>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50 shrink-0">
                        <svg className="w-3.5 h-3.5 text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                        </svg>
                        <span className="text-[10px] font-mono text-slate-600 truncate flex-1">{scriptFile?.name}</span>
                        <button type="button" title="Copy script"
                          onClick={() => { navigator.clipboard.writeText(scriptContent).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
                          className="text-slate-400 hover:text-slate-600 shrink-0">
                          {copied
                            ? <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                            : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                          }
                        </button>
                        <button type="button" title="View fullscreen" onClick={() => setScriptFullscreen(true)} className="text-slate-400 hover:text-slate-600 shrink-0">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                          </svg>
                        </button>
                      </div>
                      <div className="flex-1 overflow-auto bg-slate-950">
                        <pre className="text-[10px] font-mono leading-relaxed p-3 text-slate-300"
                          dangerouslySetInnerHTML={{ __html: scriptHighlighted! }} />
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

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-[10px] text-slate-500 space-y-1.5">
      <p className="font-semibold text-slate-600 text-[11px]">Legend</p>
      {([
        { color: "bg-blue-200 border border-blue-300",   label: "Approval task" },
        { color: "bg-violet-200 border border-violet-300", label: "Script task" },
        { color: "bg-amber-200 border border-amber-300",  label: "Gateway" },
      ] as const).map(({ color, label }) => (
        <div key={label} className="flex items-center gap-1.5">
          <span className={cn("w-3 h-3 rounded-sm inline-block shrink-0", color)} />
          <span>{label}</span>
        </div>
      ))}
      <p className="pt-1 border-t border-slate-100 text-slate-400">Click node → details</p>
    </div>
  );
}

// ── Inner graph ───────────────────────────────────────────────────────────────

function WorkflowGraphInner({ workflow, workflowId, files }: {
  workflow: WorkflowData;
  workflowId?: string;
  files: ViewableFile[];
}) {
  const { fitView, getViewport, setViewport } = useReactFlow();

  const { nodes: baseNodes, edges: baseEdges } = useMemo(() => buildGraph(workflow), [workflow]);

  const [isCompact, setIsCompact] = useState(false);

  const layoutedNodes = useMemo(
    () => isCompact ? applyDagreLayout(baseNodes, baseEdges, true) : baseNodes,
    [baseNodes, baseEdges, isCompact],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [, , onEdgesChange] = useEdgesState(baseEdges);

  // Sync nodes + fit view when layout changes
  useEffect(() => {
    setNodes(layoutedNodes);
    const t = setTimeout(() => { void fitView({ padding: 0.15, duration: 300 }); }, 80);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutedNodes, setNodes]);

  const [selectedId,    setSelectedId]    = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [pinnedEdgeId,  setPinnedEdgeId]  = useState<string | null>(null);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [searchIndex,   setSearchIndex]   = useState(0);
  const [displayView,   setDisplayView]   = useState<"graph" | "json">("graph");
  const [drawerOpen,    setDrawerOpen]    = useState(false);

  const [previewModal, setPreviewModal] = useState<{
    stepName: string;
    scriptFileName: string;
    scriptContent: string;
    copied: boolean;
    fullscreen: boolean;
  } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

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

  // Escape closes modal first, then drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (previewModal) { setPreviewModal(null); e.stopPropagation(); return; }
      if (drawerOpen)   { setDrawerOpen(false); setSelectedId(null); e.stopPropagation(); }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [drawerOpen, previewModal]);

  // Search matches
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return new Set<string>();
    const q = searchQuery.toLowerCase();
    return new Set(
      workflow.steps
        .filter((s) => s.displayName.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
        .map((s) => s.id),
    );
  }, [searchQuery, workflow.steps]);

  const searchMatchList = useMemo(
    () => workflow.steps.filter((s) => searchMatches.has(s.id)).map((s) => s.id),
    [searchMatches, workflow.steps],
  );

  useEffect(() => { setSearchIndex(0); }, [searchMatchList]);

  // Zoom to search match
  useEffect(() => {
    if (searchMatchList.length === 0) return;
    const id = searchMatchList[Math.min(searchIndex, searchMatchList.length - 1)];
    if (!id) return;
    const t = setTimeout(() => void fitView({ nodes: [{ id }], duration: 400, padding: 0.4 }), 80);
    return () => clearTimeout(t);
  }, [searchIndex, searchMatchList, fitView]);

  const goSearchPrev = useCallback(() => setSearchIndex((i) => (i - 1 + searchMatchList.length) % searchMatchList.length), [searchMatchList.length]);
  const goSearchNext = useCallback(() => setSearchIndex((i) => (i + 1) % searchMatchList.length),                          [searchMatchList.length]);

  // Path highlight
  const highlighted = useMemo(() => selectedId ? getConnected(selectedId, baseEdges) : null, [selectedId, baseEdges]);

  // Styled nodes
  const displayNodes = useMemo<Node[]>(() => nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      isSelected:    n.id === selectedId,
      isSearchMatch: searchMatches.has(n.id),
    },
    style: {
      ...n.style,
      opacity: highlighted ? (highlighted.has(n.id) ? 1 : 0.15) : 1,
      transition: "opacity 0.2s",
    },
  })), [nodes, selectedId, highlighted, searchMatches]);

  // Styled edges
  const displayEdges = useMemo<Edge[]>(() => {
    const activeEdgeId = hoveredEdgeId ?? pinnedEdgeId;
    return baseEdges.map((e) => {
      const isActive = e.id === activeEdgeId;
      const onPath   = highlighted ? (highlighted.has(e.source) && highlighted.has(e.target)) : true;
      let opacity = 1;
      if (activeEdgeId)     opacity = isActive ? 1 : 0.06;
      else if (highlighted) opacity = onPath ? 1 : 0.06;
      const isHovered = e.id === hoveredEdgeId;
      const isPinned  = e.id === pinnedEdgeId;
      const stroke    = isHovered ? "#3b82f6" : isPinned ? "#7c3aed" : "#94a3b8";
      return {
        ...e,
        style: { ...e.style, opacity, strokeWidth: isActive ? 3 : 1.5, stroke, transition: "opacity 0.15s, stroke-width 0.15s" },
        animated: !activeEdgeId && onPath && !!highlighted,
        label: opacity < 0.5 ? undefined : e.label,
      };
    });
  }, [baseEdges, highlighted, hoveredEdgeId, pinnedEdgeId]);

  // Selected step lookup
  const selectedStep  = useMemo(() => workflow.steps.find((s) => s.id === selectedId) ?? null, [selectedId, workflow.steps]);
  const stepFile      = useMemo(() => {
    if (!selectedStep) return undefined;
    return files.find((f) => {
      try { return (JSON.parse(f.content) as Record<string, unknown>).name === selectedStep.id; }
      catch { return false; }
    });
  }, [selectedStep, files]);
  const scriptFile    = useMemo(() => {
    if (!selectedStep?.hasScript || !stepFile) return undefined;
    try {
      const cfg = JSON.parse(stepFile.content) as Record<string, unknown>;
      const scriptTask = cfg.scriptTask as Record<string, unknown> | undefined;
      const scriptRef  = scriptTask?.script as Record<string, unknown> | undefined;
      const fileName   = typeof scriptRef?.file === "string" ? scriptRef.file : null;
      if (!fileName) return undefined;
      return files.find((f) => f.name === fileName);
    } catch { return undefined; }
  }, [selectedStep, stepFile, files]);

  // Lock body scroll when preview modal is open
  useEffect(() => {
    if (previewModal) { document.body.style.overflow = "hidden"; modalRef.current?.focus(); }
    else              { document.body.style.overflow = ""; }
    return () => { document.body.style.overflow = ""; };
  }, [!!previewModal]);

  const handleNodeClick: NodeMouseHandler = useCallback((_e, node) => {
    const isSame = selectedId === node.id;
    setSelectedId(isSame ? null : node.id);
    setDrawerOpen(!isSame && node.type === "wfStep");
  }, [selectedId]);

  const handleNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    if (node.type !== "wfStep") return;
    const step = workflow.steps.find((s) => s.id === node.id);
    if (!step?.hasScript) return;
    // Find the step JSON file
    const sf = files.find((f) => {
      try { return (JSON.parse(f.content) as Record<string, unknown>).name === node.id; }
      catch { return false; }
    });
    if (!sf) return;
    try {
      const cfg       = JSON.parse(sf.content) as Record<string, unknown>;
      const taskCfg   = (cfg.scriptTask ?? cfg.approvalTask) as Record<string, unknown> | undefined;
      const scriptRef = taskCfg?.script as Record<string, unknown> | undefined;
      const fileName  = typeof scriptRef?.file === "string" ? scriptRef.file : null;
      if (!fileName) return;
      const jsFile = files.find((f) => f.name === fileName);
      if (!jsFile) return;
      // Also open the drawer if not already open for this node
      if (selectedId !== node.id) { setSelectedId(node.id); setDrawerOpen(true); }
      setPreviewModal({ stepName: step.displayName, scriptFileName: fileName, scriptContent: jsFile.content, copied: false, fullscreen: false });
    } catch { /* ignore */ }
  }, [workflow.steps, files, selectedId]);

  const handleEdgeMouseEnter: EdgeMouseHandler = useCallback((_e, edge) => setHoveredEdgeId(edge.id), []);
  const handleEdgeMouseLeave: EdgeMouseHandler = useCallback(() => setHoveredEdgeId(null), []);
  const handleEdgeClick: EdgeMouseHandler      = useCallback((_e, edge) => setPinnedEdgeId((p) => p === edge.id ? null : edge.id), []);

  const handlePaneClick = useCallback(() => {
    setSelectedId(null);
    setDrawerOpen(false);
    setPinnedEdgeId(null);
  }, []);

  const topLevelJson = useMemo(() => {
    const f = files.find((f) => { try { return "staticNodes" in (JSON.parse(f.content) as object); } catch { return false; } });
    return f?.content ?? "";
  }, [files]);

  return (
    <div className="flex flex-col w-full h-full overflow-hidden">

      {/* ── Header bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-slate-200 shrink-0">
        <span className="text-sm font-semibold text-slate-800 truncate flex-1">{workflowId ?? workflow.displayName}</span>

        {/* Search */}
        <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded px-2 py-1 shrink-0">
          <svg className="w-3 h-3 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text" value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search steps…"
            className="text-xs w-28 outline-none text-slate-700 placeholder-slate-400 bg-transparent"
          />
          {searchQuery && (
            <>
              <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
                {searchMatchList.length > 1
                  ? `${searchIndex + 1} / ${searchMatchList.length}`
                  : `${searchMatchList.length} match${searchMatchList.length !== 1 ? "es" : ""}`}
              </span>
              <button type="button" onClick={() => setSearchQuery("")} className="text-slate-400 hover:text-slate-600 shrink-0">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {searchMatchList.length > 1 && (
                <>
                  <div className="w-px h-3.5 bg-slate-200 shrink-0" />
                  <button type="button" onClick={goSearchPrev} className="text-slate-400 hover:text-sky-600 shrink-0 text-sm leading-none">‹</button>
                  <button type="button" onClick={goSearchNext} className="text-slate-400 hover:text-sky-600 shrink-0 text-sm leading-none">›</button>
                </>
              )}
            </>
          )}
        </div>

        {/* View toggle */}
        <div className="flex rounded border border-slate-300 overflow-hidden text-[11px] shrink-0">
          {(["graph", "json"] as const).map((v, i) => (
            <button key={v} type="button" onClick={() => setDisplayView(v)}
              className={cn(
                "px-2.5 py-1 transition-colors",
                i > 0 && "border-l border-slate-300",
                displayView === v ? "bg-sky-600 text-white" : "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
              )}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        {/* Graph-only controls */}
        {displayView === "graph" && (
          <>
            {/* Compact toggle */}
            <button
              type="button"
              onClick={() => setIsCompact((v) => !v)}
              title={isCompact ? "Switch to original layout" : "Switch to compact layout"}
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

            {/* Fit view */}
            <button type="button" onClick={() => void fitView({ duration: 400, padding: 0.15 })}
              title="Fit view" className="text-slate-400 hover:text-sky-600 transition-colors shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {displayView === "json" ? (
          <div className="h-full overflow-auto bg-slate-950 p-4">
            <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all">
              {(() => { try { return JSON.stringify(JSON.parse(topLevelJson), null, 2); } catch { return topLevelJson; } })()}
            </pre>
          </div>
        ) : (
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            onEdgeMouseEnter={handleEdgeMouseEnter}
            onEdgeMouseLeave={handleEdgeMouseLeave}
            onEdgeClick={handleEdgeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onPaneClick={handlePaneClick}
            nodesDraggable
            snapToGrid
            snapGrid={[20, 20]}
            minZoom={0.1}
            maxZoom={2}
          >
            <Panel position="top-left"><Legend /></Panel>
            <Background color="#e2e8f0" gap={20} size={1} />
            <Controls showInteractive={false} showFitView={false} />
            <MiniMap
              nodeColor={(n) => {
                if (n.type === "wfStart") return "#10b981";
                if (n.type === "wfEnd")   return "#475569";
                const k = (n.data as { kind?: string }).kind;
                if (k === "approvalTask")     return "#93c5fd";
                if (k === "exclusiveGateway") return "#fcd34d";
                return "#c4b5fd";
              }}
              zoomable pannable
              maskColor="rgba(241,245,249,0.7)"
            />
          </ReactFlow>
        )}

        {/* Step drawer */}
        <StepDrawer
          step={selectedStep}
          stepFile={stepFile}
          scriptFile={scriptFile}
          open={drawerOpen}
          onClose={() => { setDrawerOpen(false); setSelectedId(null); }}
        />

        {/* ── Script preview modal (double-click) ──────────────────────────── */}
        {previewModal && (
          <>
            {previewModal.fullscreen ? (
              <ScriptOverlay
                name={previewModal.scriptFileName}
                content={previewModal.scriptContent}
                onClose={() => setPreviewModal((p) => p ? { ...p, fullscreen: false } : null)}
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
                  style={{ width: "60vw", maxWidth: 960, height: "60vh", maxHeight: "90vh" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Modal header */}
                  <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{previewModal.stepName}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">Script preview</p>
                    </div>
                    {/* Copy */}
                    <button
                      type="button"
                      title="Copy script"
                      onClick={() => {
                        void navigator.clipboard.writeText(previewModal.scriptContent).then(() => {
                          setPreviewModal((p) => p ? { ...p, copied: true } : null);
                          setTimeout(() => setPreviewModal((p) => p ? { ...p, copied: false } : null), 2000);
                        });
                      }}
                      className="text-slate-400 hover:text-slate-600 shrink-0 transition-colors"
                    >
                      {previewModal.copied ? (
                        <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      )}
                    </button>
                    {/* Fullscreen */}
                    <button
                      type="button"
                      title="View fullscreen"
                      onClick={() => setPreviewModal((p) => p ? { ...p, fullscreen: true } : null)}
                      className="text-slate-400 hover:text-slate-600 shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                      </svg>
                    </button>
                    {/* Close */}
                    <button type="button" onClick={() => setPreviewModal(null)} className="text-slate-400 hover:text-slate-600 shrink-0">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  {/* Script content */}
                  <div className="flex-1 min-h-0 overflow-hidden bg-slate-950">
                    <p className="px-4 pt-3 pb-1 text-[10px] font-medium text-slate-400 shrink-0">{previewModal.scriptFileName}</p>
                    <div className="overflow-auto h-full">
                      <pre
                        className="px-4 pb-4 text-[11px] font-mono leading-relaxed text-slate-300"
                        dangerouslySetInnerHTML={{ __html: withLineNumbers(highlightJs(previewModal.scriptContent)) }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export function WorkflowGraph({ files, workflowId }: { files: ViewableFile[]; workflowId?: string }) {
  const workflow = useMemo(() => {
    const topFile = files.find((f) => {
      try { return "staticNodes" in (JSON.parse(f.content) as Record<string, unknown>); }
      catch { return false; }
    });
    if (!topFile) return null;
    const stepJsons = files.filter((f) => f !== topFile && f.language === "json").map((f) => f.content);
    return parseWorkflowData(topFile.content, stepJsons);
  }, [files]);

  if (!workflow) {
    return <div className="flex items-center justify-center h-full text-sm text-slate-400">Could not parse workflow data.</div>;
  }

  return (
    <div className="h-full bg-slate-50">
      <ReactFlowProvider>
        <WorkflowGraphInner workflow={workflow} workflowId={workflowId} files={files} />
      </ReactFlowProvider>
    </div>
  );
}
