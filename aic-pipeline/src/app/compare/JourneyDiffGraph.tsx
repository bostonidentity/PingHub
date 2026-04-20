"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from "react";
import {
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { cn } from "@/lib/utils";
import { highlightJs, withLineNumbers } from "@/lib/highlight";
import { js_beautify } from "js-beautify";
import { ScriptOverlay } from "../configs/ScriptOverlay";
import { DiffMinimap } from "./DiffMinimap";
import { DiffGraphCanvas } from "@/components/diff-graph/DiffGraphCanvas";
import { JourneyLegendModal } from "@/components/JourneyLegendModal";
import {
  parseMergedDiffGraph,
  parseSingleSideGraph,
  parseNodesOnlyGraph,
  type DiffStatus,
  type PageChildConfig,
  type PageNodeConfig,
  DIFF_SUCCESS_ID,
  DIFF_FAILURE_ID,
  DIFF_NODE_W,
  DIFF_TERM_SIZE,
  DIFF_START_SIZE,
  DIFF_PAGE_GROUP_W,
  DIFF_PAGE_CHILD_W,
  DIFF_PAGE_CHILD_H,
  DIFF_PAGE_GROUP_TOP,
  DIFF_PAGE_GROUP_PAD,
  DIFF_PAGE_CHILD_GAP,
  diffNodeHeight,
  diffPageGroupHeight,
} from "@/lib/journey-diff-graph";
import type { FileDiff, JourneyNodeInfo } from "@/lib/diff-types";
import { JourneyGraph      } from "../configs/JourneyGraph";
import { JourneyOutlineView } from "../configs/JourneyOutlineView";
import { JourneyTableView   } from "../configs/JourneyTableView";
import { JourneySwimLaneView } from "../configs/JourneySwimLaneView";

// ── Custom node components ────────────────────────────────────────────────────

function statusBorderBg(status: DiffStatus): string {
  switch (status) {
    case "modified":  return "border-amber-400 bg-amber-50";
    case "added":     return "border-emerald-400 bg-emerald-50";
    case "removed":   return "border-red-400 bg-red-50 border-dashed opacity-70";
    case "unchanged": return "border-slate-300 bg-white";
  }
}

function statusBadgeClass(status: DiffStatus): string {
  switch (status) {
    case "modified":  return "bg-amber-100 text-amber-700";
    case "added":     return "bg-emerald-100 text-emerald-700";
    case "removed":   return "bg-red-100 text-red-700";
    case "unchanged": return "bg-slate-100 text-slate-500";
  }
}

function statusBadgeLabel(status: DiffStatus): string {
  switch (status) {
    case "modified":  return "M";
    case "added":     return "A";
    case "removed":   return "D";
    case "unchanged": return "";
  }
}

function DiffStatusBadge({ status }: { status?: DiffStatus }) {
  if (!status) return null;
  const label = statusBadgeLabel(status);
  if (!label) return <span className="text-[10px] text-slate-400">unchanged</span>;
  return (
    <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded", statusBadgeClass(status))}>
      {label === "M" ? "modified" : label === "A" ? "added" : "deleted"}
    </span>
  );
}

// ── Property viewer ───────────────────────────────────────────────────────────

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

function JourneyDiffNodeComponent({ data }: NodeProps) {
  const d = data as {
    label: string;
    nodeType?: string;
    outcomes: string[];
    diffStatus: DiffStatus;
    modifiedReason?: "script" | "subjourney";
    isFocused?: boolean;
    isSearchMatch?: boolean;
  };
  const outcomes       = d.outcomes ?? [];
  const h              = diffNodeHeight(outcomes.length);
  const status         = d.diffStatus ?? "unchanged";
  const modifiedReason = d.modifiedReason;
  const isInner        = d.nodeType === "InnerTreeEvaluatorNode";
  const isScript       = d.nodeType === "ScriptedDecisionNode";
  const isFocused      = !!d.isFocused;
  const isSearchMatch  = !!d.isSearchMatch;

  // Special node types (script / inner tree) always keep their type-based bg.
  // Their border is solid when unchanged, dashed (with diff-status color) when changed.
  // Regular nodes keep the existing combined border+bg treatment.
  function nodeBorderBg(): string {
    if (isScript || isInner) {
      const typeBg = isScript ? "bg-violet-50" : "bg-amber-50";
      if (status === "unchanged") return `border-slate-300 ${typeBg}`;
      // changed: dashed border in diff-status color, bg stays type-based
      const borderColor = (() => {
        if (status === "modified") {
          if (modifiedReason === "script")     return "border-orange-400";
          if (modifiedReason === "subjourney") return "border-violet-400";
          return "border-amber-400";
        }
        if (status === "added")   return "border-emerald-400";
        if (status === "removed") return "border-red-400";
        return "border-slate-300";
      })();
      const removed = status === "removed" ? "opacity-70" : "";
      return [borderColor, "border-dashed", typeBg, removed].filter(Boolean).join(" ");
    }
    // Regular nodes: existing behavior
    if (status === "modified") {
      if (modifiedReason === "script")     return "border-orange-400 bg-orange-50";
      if (modifiedReason === "subjourney") return "border-violet-400 bg-violet-50";
    }
    return statusBorderBg(status);
  }

  function nodeBadgeClass(): string {
    if (status === "modified") {
      if (modifiedReason === "script")    return "bg-orange-100 text-orange-700";
      if (modifiedReason === "subjourney") return "bg-violet-100 text-violet-700";
    }
    return statusBadgeClass(status);
  }

  const badgeLabel = statusBadgeLabel(status);

  return (
    <div
      className={cn(
        "border rounded-lg shadow-sm overflow-visible relative",
        nodeBorderBg(),
        isFocused && "ring-4 ring-red-500 ring-offset-2",
        isSearchMatch && "ring-2 ring-amber-400 ring-offset-1",
      )}
      style={{ width: DIFF_NODE_W, height: h }}
    >
      <Handle type="target" position={Position.Left} style={{ top: "50%", background: "#94a3b8" }} />

      {/* Status badge */}
      {badgeLabel && (
        <span
          className={cn(
            "absolute top-0.5 right-0.5 text-[9px] font-bold px-1 rounded",
            nodeBadgeClass(),
          )}
        >
          {badgeLabel}
        </span>
      )}

      <div className="px-3 pt-2" style={{ paddingRight: outcomes.length > 0 ? 56 : 20 }}>
        <p className="text-[11px] font-medium text-slate-700 leading-snug break-words">{d.label}</p>
        {d.nodeType && <p className="text-[9px] text-slate-400 mt-0.5 truncate">{d.nodeType}</p>}
        {modifiedReason === "script" && (
          <p className="text-[9px] text-orange-500 mt-0.5 font-medium">script changed</p>
        )}
        {modifiedReason === "subjourney" && (
          <p className="text-[9px] text-violet-500 mt-0.5 font-medium">sub-journey changed</p>
        )}
        {isInner && !modifiedReason && (
          <p className="text-[9px] text-amber-500 mt-0.5 font-medium">⤵ (inner)</p>
        )}
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

function DiffStartNodeComponent(_: NodeProps) {
  return (
    <div
      className="rounded-full flex items-center justify-center shadow font-bold text-white text-[9px] bg-emerald-500"
      style={{ width: DIFF_START_SIZE, height: DIFF_START_SIZE }}
    >
      <Handle type="source" position={Position.Right} style={{ background: "#059669" }} />
      START
    </div>
  );
}

function DiffSuccessNodeComponent(_: NodeProps) {
  return (
    <div
      className="rounded-full border-2 border-emerald-400 bg-emerald-50 flex items-center justify-center shadow-sm font-bold text-emerald-700 text-[10px] text-center leading-tight"
      style={{ width: DIFF_TERM_SIZE, height: DIFF_TERM_SIZE }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#34d399" }} />
      ✓<br />OK
    </div>
  );
}

function DiffFailureNodeComponent(_: NodeProps) {
  return (
    <div
      className="rounded-full border-2 border-red-400 bg-red-50 flex items-center justify-center shadow-sm font-bold text-red-700 text-[10px] text-center leading-tight"
      style={{ width: DIFF_TERM_SIZE, height: DIFF_TERM_SIZE }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#f87171" }} />
      ✗<br />Fail
    </div>
  );
}

function PageGroupDiffNodeComponent({ data }: NodeProps) {
  const d = data as {
    label: string;
    children: PageChildConfig[];
    outcomes?: string[];
    diffStatus: DiffStatus;
    modifiedReason?: "script" | "subjourney";
    isSearchMatch?: boolean;
  };
  const outcomes = d.outcomes ?? [];
  const h = diffPageGroupHeight(Math.max((d.children ?? []).length, 1));

  function borderBg(): string {
    if (d.diffStatus === "modified") {
      if (d.modifiedReason === "script")     return "border-orange-400 bg-violet-50/60 border-dashed";
      if (d.modifiedReason === "subjourney") return "border-violet-400 bg-violet-50/60 border-dashed";
      return "border-amber-400 bg-violet-50/60 border-dashed";
    }
    if (d.diffStatus === "added")   return "border-emerald-400 bg-violet-50/60 border-dashed";
    if (d.diffStatus === "removed") return "border-red-400 bg-violet-50/60 opacity-70 border-dashed";
    return "border-violet-300 bg-violet-50/60"; // unchanged: solid
  }

  return (
    <div
      className={cn(
        "border-2 rounded-xl transition-all cursor-pointer",
        borderBg(),
        d.isSearchMatch && "ring-2 ring-amber-400 ring-offset-1",
      )}
      style={{ width: DIFF_PAGE_GROUP_W, height: h, position: "relative" }}
    >
      <Handle type="target" position={Position.Left} style={{ top: "50%", background: "#94a3b8" }} />
      <div className="px-3 pt-2 pb-1 border-b border-violet-200/80">
        <p className="text-[9px] font-semibold text-violet-500 uppercase tracking-wider">Page Node</p>
        <p className="text-[11px] font-medium text-slate-700 leading-tight truncate">{d.label}</p>
      </div>
      {outcomes.length > 0
        ? outcomes.map((outcome, i) => {
            const topPct = `${((i + 0.5) / outcomes.length) * 100}%`;
            return <Handle key={outcome} id={outcome} type="source" position={Position.Right} style={{ top: topPct, background: "#94a3b8" }} />;
          })
        : <Handle type="source" position={Position.Right} style={{ top: "50%", background: "#94a3b8" }} />
      }
    </div>
  );
}

function PageChildDiffNodeComponent({ data }: NodeProps) {
  const d = data as { label: string; nodeType: string; diffStatus: DiffStatus; isSearchMatch?: boolean };
  const borderColor =
    d.diffStatus === "added"    ? "border-emerald-300" :
    d.diffStatus === "removed"  ? "border-red-300"     :
    d.diffStatus === "modified" ? "border-amber-300"   : "border-violet-200";
  return (
    <div
      className={cn(
        "bg-white border rounded-md shadow-sm px-2 flex flex-col justify-center cursor-pointer transition-all",
        borderColor,
        d.isSearchMatch ? "ring-1 ring-amber-400" : "hover:ring-1 hover:ring-sky-300",
      )}
      style={{ width: DIFF_PAGE_CHILD_W, height: DIFF_PAGE_CHILD_H }}
    >
      <p className="text-[10px] font-medium text-slate-700 leading-tight truncate">{d.label}</p>
      <p className="text-[9px] text-violet-400 truncate">{d.nodeType}</p>
    </div>
  );
}

const nodeTypes = {
  journeyDiffNode: JourneyDiffNodeComponent,
  pageGroup:       PageGroupDiffNodeComponent,
  pageChild:       PageChildDiffNodeComponent,
  startNode:       DiffStartNodeComponent,
  successNode:     DiffSuccessNodeComponent,
  failureNode:     DiffFailureNodeComponent,
};

const journeyMiniMapNodeColor = (n: Node): string => {
  if (n.data.diffStatus === "modified") {
    if (n.data.modifiedReason === "script")     return "#f97316";
    if (n.data.modifiedReason === "subjourney") return "#8b5cf6";
    return "#f59e0b";
  }
  switch (n.data.diffStatus as "added" | "removed" | "unchanged") {
    case "added":   return "#10b981";
    case "removed": return "#ef4444";
    default:        return "#94a3b8";
  }
};

// ── Dagre layout ──────────────────────────────────────────────────────────────

function getNodeDims(node: Node): [number, number] {
  if (node.type === "startNode")   return [DIFF_START_SIZE, DIFF_START_SIZE];
  if (node.type === "successNode") return [DIFF_TERM_SIZE,  DIFF_TERM_SIZE];
  if (node.type === "failureNode") return [DIFF_TERM_SIZE,  DIFF_TERM_SIZE];
  if (node.type === "pageGroup") {
    const children = (node.data.children as PageChildConfig[] | undefined) ?? [];
    return [DIFF_PAGE_GROUP_W, diffPageGroupHeight(Math.max(children.length, 1))];
  }
  const outcomes = (node.data.outcomes as string[] | undefined) ?? [];
  return [DIFF_NODE_W, diffNodeHeight(outcomes.length)];
}

function runDagreLayout(
  nodes: Node[],
  edges: Edge[],
  opts: { nodesep: number; ranksep: number },
): Node[] {
  if (nodes.length === 0) return nodes;
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: opts.nodesep, ranksep: opts.ranksep, marginx: 40, marginy: 40 });
  // Only layout top-level nodes; children keep relative position inside parent
  nodes.filter((n) => !n.parentId).forEach((n) => {
    const [w, h] = getNodeDims(n);
    g.setNode(n.id, { width: w, height: h });
  });
  edges.forEach((e) => {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target);
    }
  });
  dagre.layout(g);
  return nodes.map((n) => {
    if (n.parentId) return n; // child: keep relative position
    const pos = g.node(n.id);
    if (!pos) return n;
    const [w, h] = getNodeDims(n);
    return { ...n, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
  });
}

function applyLayout(nodes: Node[], edges: Edge[]): Node[] {
  return runDagreLayout(nodes, edges, { nodesep: 60, ranksep: 160 });
}

function applyCompactLayout(nodes: Node[], edges: Edge[]): Node[] {
  return runDagreLayout(nodes, edges, { nodesep: 25, ranksep: 60 });
}

// ── Legend ────────────────────────────────────────────────────────────────────

function DiffLegend() {
  return <JourneyLegendModal variant="diff" />;
}

// ── Unchanged script viewer ───────────────────────────────────────────────────

function UnchangedScriptViewer({ name, content }: { name: string; content: string }) {
  const [copied, setCopied]         = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const highlighted = useMemo(() => withLineNumbers(highlightJs(content)), [content]);

  function handleCopy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <>
      {fullscreen && <ScriptOverlay name={name} content={content} onClose={() => setFullscreen(false)} />}
      <div className="border border-slate-200 rounded overflow-hidden mx-3 mb-2">
        <div className="flex items-center gap-2 px-2 py-1 bg-slate-50 border-b border-slate-200">
          <svg className="w-3 h-3 text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
          </svg>
          <span className="text-[9px] font-mono text-slate-500 truncate flex-1">{name}</span>
          <button type="button" onClick={handleCopy} title="Copy" className="text-slate-400 hover:text-slate-600 shrink-0 transition-colors">
            {copied
              ? <svg className="w-3 h-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              : <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
            }
          </button>
          <button type="button" onClick={() => setFullscreen(true)} title="Fullscreen" className="text-slate-400 hover:text-slate-600 shrink-0">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
          </button>
        </div>
        <div className="bg-slate-950 overflow-auto max-h-64">
          <pre className="text-[9px] font-mono leading-relaxed p-2 text-slate-300" dangerouslySetInnerHTML={{ __html: highlighted }} />
        </div>
      </div>
    </>
  );
}

// ── ScriptFileEntry ───────────────────────────────────────────────────────────

/** One file (config or content) inside the Scripts panel for a changed script. */
function ScriptFileEntry({ f }: { f: FileDiff }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [fsTab, setFsTab]           = useState<"diff" | "files">("diff");
  const [fsCopied, setFsCopied]     = useState(false);
  const fsScrollRef = useRef<HTMLDivElement>(null);

  const fmtLocal  = f.localContent  != null ? formatForDisplay(f.localContent,  f.relativePath) : null;
  const fmtRemote = f.remoteContent != null ? formatForDisplay(f.remoteContent, f.relativePath) : null;

  let diffLines: DiffLineLocal[] = [];
  if (fmtLocal != null && fmtRemote != null) {
    diffLines = clientDiff(fmtLocal, fmtRemote);
  } else if (fmtRemote != null) {
    diffLines = fmtRemote.split("\n").map((c) => ({ type: "added" as const, content: c }));
  } else if (fmtLocal != null) {
    diffLines = fmtLocal.split("\n").map((c) => ({ type: "removed" as const, content: c }));
  } else if (f.diffLines && f.diffLines.length > 0) {
    diffLines = f.diffLines as DiffLineLocal[];
  }

  const fileLabel    = f.relativePath.split("/").pop() ?? f.relativePath;
  const changedLines = diffLines.filter((l) => l.type !== "context");
  const hasBothSides = fmtLocal != null && fmtRemote != null;

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [fullscreen]);

  return (
    <>
      {fullscreen && (
        <div className="fixed inset-0 z-[80] flex flex-col bg-slate-950 overflow-hidden">
          {/* Fullscreen header */}
          <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-800 bg-slate-900 shrink-0">
            <svg className="w-4 h-4 text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
            <span className="text-sm font-mono font-medium text-slate-200 flex-1 truncate">{fileLabel}</span>
            <DiffStatusBadge status={f.status as DiffStatus} />
            {changedLines.length > 0 && (
              <span className="text-[10px] text-slate-400 shrink-0">
                +{changedLines.filter((l) => l.type === "added").length}
                {" "}-{changedLines.filter((l) => l.type === "removed").length}
              </span>
            )}
            {hasBothSides && (
              <div className="flex gap-0.5 bg-slate-800 rounded-md p-0.5 shrink-0">
                {(["diff", "files"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setFsTab(tab)}
                    className={cn(
                      "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                      fsTab === tab
                        ? "bg-slate-600 text-slate-100 shadow-sm"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                  >
                    {tab === "diff" ? "Diff" : "Files"}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              title="Copy script"
              onClick={() => {
                const copyText = fmtRemote ?? fmtLocal ?? diffLines.filter((l) => l.type !== "removed").map((l) => l.content).join("\n");
                void navigator.clipboard.writeText(copyText).then(() => {
                  setFsCopied(true);
                  setTimeout(() => setFsCopied(false), 2000);
                });
              }}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors shrink-0"
            >
              {fsCopied ? (
                <>
                  <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-emerald-400">Copied</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                  <span>Copy</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              title="Close (Esc)"
              className="text-slate-400 hover:text-slate-200 transition-colors shrink-0"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* Fullscreen body */}
          <div className="flex-1 min-h-0 overflow-hidden flex">
            {diffLines.length > 0 ? (
              hasBothSides && fsTab === "files" ? (
                <SplitDiffView lines={diffLines} fullscreen />
              ) : (
                <>
                  <div ref={fsScrollRef} className="flex-1 overflow-auto text-[11px] font-mono leading-5">
                    <table className="w-full border-collapse table-fixed">
                      <tbody>
                        {diffLines.map((l, i) => {
                          const bg  = l.type === "added" ? "bg-emerald-950" : l.type === "removed" ? "bg-red-950" : "";
                          const txt = l.type === "added" ? "text-emerald-300" : l.type === "removed" ? "text-red-300" : "text-slate-400";
                          const pfx = l.type === "added" ? "+" : l.type === "removed" ? "-" : " ";
                          return (
                            <tr key={i} className={bg}>
                              <td className={cn("px-2 py-0 select-none w-5 shrink-0", l.type === "added" ? "text-emerald-400" : l.type === "removed" ? "text-red-400" : "text-slate-600")}>{pfx}</td>
                              <td className={cn("px-2 py-0 whitespace-pre-wrap break-all", txt)}>{l.content}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <DiffMinimap lines={diffLines} scrollRef={fsScrollRef} />
                </>
              )
            ) : (
              <p className="px-4 py-4 text-sm text-slate-400">No changes</p>
            )}
          </div>
        </div>
      )}
      <div className="px-3 pb-1">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[9px] font-mono text-slate-400 truncate flex-1">{fileLabel}</span>
          <DiffStatusBadge status={f.status as DiffStatus} />
          {changedLines.length > 0 && (
            <span className="text-[9px] text-slate-400">
              +{changedLines.filter((l) => l.type === "added").length}
              {" "}-{changedLines.filter((l) => l.type === "removed").length}
            </span>
          )}
          {diffLines.length > 0 && (
            <button
              type="button"
              title="View fullscreen"
              onClick={() => setFullscreen(true)}
              className="text-slate-400 hover:text-slate-600 shrink-0 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            </button>
          )}
        </div>
        {diffLines.length > 0 ? (
          <InlineDiffView lines={diffLines} />
        ) : (
          <p className="text-[10px] text-slate-400 italic">No changes</p>
        )}
      </div>
    </>
  );
}

// ── Script panel content ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightLine(raw: string): string {
  return escapeHtml(raw).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let color = "#60a5fa";
      if (/^"/.test(match)) color = /:$/.test(match) ? "#94a3b8" : "#86efac";
      else if (/true|false/.test(match)) color = "#fbbf24";
      else if (/null/.test(match)) color = "#f87171";
      return `<span style="color:${color}">${match}</span>`;
    },
  );
}

type DiffLineLocal = { type: "added" | "removed" | "context"; content: string };

function formatForDisplay(content: string, relativePath: string): string {
  const ext = (relativePath.split(".").pop() ?? "").toLowerCase();
  if (ext === "json") {
    try { return JSON.stringify(JSON.parse(content), null, 2); } catch { /* not JSON */ }
  }
  if (ext === "js" || ext === "groovy") {
    try { return js_beautify(content, { indent_size: 2, end_with_newline: true }); } catch { /* ignore */ }
  }
  return content;
}

function clientDiff(aText: string, bText: string): DiffLineLocal[] {
  const a = aText === "" ? [] : aText.split("\n");
  const b = bText === "" ? [] : bText.split("\n");
  const m = a.length, n = b.length;
  if (m > 2000 || n > 2000) return [{ type: "context", content: "(file too large to diff in browser)" }];
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const lines: DiffLineLocal[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { lines.unshift({ type: "context", content: a[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { lines.unshift({ type: "added", content: b[j - 1] }); j--; }
    else { lines.unshift({ type: "removed", content: a[i - 1] }); i--; }
  }
  return lines;
}

function SplitDiffView({ lines, fullscreen }: { lines: DiffLineLocal[]; fullscreen?: boolean }) {
  type SplitRow = { left: string | null; leftRem: boolean; right: string | null; rightAdd: boolean };
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo((): SplitRow[] => {
    const result: SplitRow[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].type === "context") {
        result.push({ left: lines[i].content, leftRem: false, right: lines[i].content, rightAdd: false });
        i++;
      } else {
        const removed: string[] = [];
        const added: string[] = [];
        while (i < lines.length && lines[i].type !== "context") {
          if (lines[i].type === "removed") removed.push(lines[i].content);
          else added.push(lines[i].content);
          i++;
        }
        const len = Math.max(removed.length, added.length);
        for (let j = 0; j < len; j++) {
          result.push({
            left: removed[j] ?? null,
            leftRem: removed[j] !== undefined,
            right: added[j] ?? null,
            rightAdd: added[j] !== undefined,
          });
        }
      }
    }
    return result;
  }, [lines]);

  return (
    <div className={cn(
      "flex bg-slate-950 overflow-hidden",
      fullscreen ? "flex-1 min-h-0" : "max-h-[500px]",
    )}>
      <div ref={scrollRef} className="flex-1 overflow-auto text-[10px] font-mono leading-5">
        <table className="w-full border-collapse table-fixed">
          <thead>
            <tr className="border-b border-slate-700 bg-slate-900 text-[9px] text-slate-500 sticky top-0 z-10">
              <th className="px-3 py-1 text-left font-normal border-r border-slate-700 w-1/2">Source</th>
              <th className="px-3 py-1 text-left font-normal w-1/2">Modified</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className={cn(
                  "px-3 py-0 whitespace-pre-wrap break-all align-top border-r border-slate-800 w-1/2",
                  row.leftRem ? "bg-red-950 text-red-300" : "text-slate-400",
                )}>
                  {row.left ?? ""}
                </td>
                <td className={cn(
                  "px-3 py-0 whitespace-pre-wrap break-all align-top w-1/2",
                  row.rightAdd ? "bg-emerald-950 text-emerald-300" : "text-slate-400",
                )}>
                  {row.right ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DiffMinimap lines={lines} scrollRef={scrollRef} />
    </div>
  );
}

function InlineDiffView({ lines }: { lines: DiffLineLocal[] }) {
  const MAX = 300;
  const visible = lines.slice(0, MAX);
  return (
    <div className="overflow-x-auto overflow-y-auto bg-slate-950 text-[10px] font-mono leading-5 max-h-64">
      <table className="min-w-full border-collapse">
        <tbody>
          {visible.map((l, i) => {
            const bg   = l.type === "added" ? "bg-emerald-950" : l.type === "removed" ? "bg-red-950" : "";
            const text = l.type === "added" ? "text-emerald-300" : l.type === "removed" ? "text-red-300" : "text-slate-400";
            const pfx  = l.type === "added" ? "+" : l.type === "removed" ? "-" : " ";
            const pfxColor = l.type === "added" ? "text-emerald-400" : l.type === "removed" ? "text-red-400" : "text-slate-600";
            return (
              <tr key={i} className={bg}>
                <td className={cn("px-1 py-0 select-none w-4", pfxColor)}>{pfx}</td>
                <td
                  className={cn("px-2 py-0 whitespace-pre", text)}
                  dangerouslySetInnerHTML={{ __html: highlightLine(l.content) }}
                />
              </tr>
            );
          })}
          {lines.length > MAX && (
            <tr>
              <td colSpan={2} className="text-center text-slate-500 py-1 text-[9px]">
                …{lines.length - MAX} more lines
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface ScriptEntry {
  uuid: string;
  name: string;
  /** Present when the script is in the diff (changed). */
  configFile?: FileDiff;
  contentFile?: FileDiff;
  /** Present when the script is unchanged and was fetched from the API. */
  fetchedContent?: string | null;
  /** Full filename (e.g. "myScript.js") — used for formatting fetchedContent. */
  fetchedFilename?: string;
}

function ScriptPanelContent({
  nodeId,
  journeyName,
  diffStatus,
  files,
  sourceEnv,
  targetEnv,
}: {
  nodeId?: string | null;
  nodeType?: string;
  journeyName?: string;
  diffStatus?: DiffStatus;
  files: FileDiff[];
  sourceEnv: string;
  targetEnv: string;
}) {
  const [loading, setLoading]   = useState(false);
  const [entries, setEntries]   = useState<ScriptEntry[]>([]);
  const [message, setMessage]   = useState<string | null>(null);

  useEffect(() => {
    if (!nodeId) { setEntries([]); setMessage(null); return; }

    let cancelled = false;
    setLoading(true);
    setEntries([]);
    setMessage(null);

    const run = async () => {
      // ── Step 1: resolve node config content ──────────────────────────────
      const nodeConfigFile = files.find(
        (f) => f.relativePath.includes(`/${nodeId}.json`) && f.relativePath.includes("/nodes/"),
      );
      let nodeContent = nodeConfigFile?.localContent ?? nodeConfigFile?.remoteContent ?? null;

      // Env probing order: prefer the env that should have the node based on diff
      // status, but always fall back to the other side so source-only items (target
      // has deleted them) still resolve.
      const primaryFirst =
        diffStatus === "added" ? targetEnv :
        diffStatus === "removed" ? sourceEnv :
        (sourceEnv || targetEnv);
      const envCandidates = Array.from(
        new Set([primaryFirst, sourceEnv, targetEnv].filter((e): e is string => !!e)),
      );

      if (!nodeContent && journeyName) {
        for (const env of envCandidates) {
          if (cancelled || nodeContent) break;
          try {
            const params = new URLSearchParams({ environment: env, journey: journeyName, nodeId });
            const res = await fetch(`/api/push/journey-node?${params}`);
            if (!res.ok) continue;
            const data = await res.json() as { file?: { content?: string } };
            if (data.file?.content) nodeContent = data.file.content;
          } catch { /* try next */ }
        }
      }

      if (cancelled) return;
      if (!nodeContent) { setMessage("No config file found for this node."); setLoading(false); return; }

      // ── Step 2: extract script UUIDs ──────────────────────────────────────
      let nodeJson: Record<string, unknown> | null = null;
      try { nodeJson = JSON.parse(nodeContent); } catch { /* ignore */ }

      const scriptUuids: string[] = [];
      if (nodeJson) {
        for (const val of Object.values(nodeJson)) {
          if (typeof val === "string" && UUID_RE.test(val)) scriptUuids.push(val);
        }
      }

      if (!scriptUuids.length) { setMessage("No scripts linked to this node."); setLoading(false); return; }

      // ── Step 3: build entries — diff files first, API fallback for unchanged ──
      const result: ScriptEntry[] = [];

      for (const uuid of scriptUuids) {
        if (cancelled) break;

        const configFile = files.find((f) => f.relativePath.includes(`/scripts-config/${uuid}.json`));

        // Try each env in order until we get a non-empty response (source-only items
        // will 404 on target; we transparently fall back to source).
        let name = uuid;
        let scriptFilename: string | undefined;
        let fetchedFilename: string | undefined;
        let fetchedContent: string | null | undefined;
        let gotAny = false;
        for (const env of envCandidates) {
          if (cancelled) break;
          try {
            const params = new URLSearchParams({ environment: env, scriptId: uuid });
            const res = await fetch(`/api/push/script?${params}`);
            if (!res.ok) continue;
            const data = await res.json() as { name?: string; content?: string | null; filename?: string };
            if (!data.name && data.content == null && !data.filename) continue;
            if (data.name) name = data.name;
            if (data.filename) {
              fetchedFilename = data.filename;
              scriptFilename = data.filename.replace(/\.[^.]+$/, "");
            }
            fetchedContent = data.content ?? null;
            gotAny = true;
            if (data.content != null) break;
          } catch { /* try next */ }
        }
        if (!gotAny && configFile) {
          const cfgContent = configFile.localContent ?? configFile.remoteContent;
          if (cfgContent) {
            try {
              const j = JSON.parse(cfgContent) as Record<string, unknown>;
              if (typeof j.name === "string" && j.name) name = j.name;
            } catch { /* ignore */ }
          }
        }

        if (cancelled) break;

        const contentFile = files.find(
          (f) => f.relativePath.includes("/scripts-content/") && (() => {
            const base = f.relativePath.split("/").pop()?.replace(/\.[^.]+$/, "");
            return base === scriptFilename || base === name;
          })(),
        );

        const hasChanges = configFile || (contentFile && contentFile.status !== "unchanged");
        if (hasChanges) {
          result.push({ uuid, name, configFile, contentFile });
        } else {
          result.push({ uuid, name, fetchedContent: fetchedContent ?? null, fetchedFilename });
        }
      }

      if (cancelled) return;
      if (!result.length) setMessage("No scripts found for this node.");
      else setEntries(result);
      setLoading(false);
    };

    void run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, journeyName, sourceEnv, targetEnv, files]);

  if (!nodeId)  return <p className="px-3 py-2 text-xs text-slate-400">No node selected.</p>;
  if (loading)  return <p className="px-3 py-2 text-xs text-slate-400">Loading scripts…</p>;
  if (message)  return <div className="px-3 py-2 text-xs text-slate-400">{message}</div>;

  return (
    <div className="divide-y divide-slate-100">
      {entries.map((entry) => (
        <div key={entry.uuid} className="py-2">
          <div className="flex items-center gap-1.5 px-3 pb-1">
            <svg className="w-3 h-3 text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
            <span className="text-[11px] font-medium text-slate-700 truncate">{entry.name}</span>
            {!(entry.configFile || entry.contentFile) && (
              <span className="ml-auto shrink-0"><DiffStatusBadge status="unchanged" /></span>
            )}
          </div>

          {/* Unchanged script fetched from API — render as plain viewer */}
          {!(entry.configFile || entry.contentFile) && entry.fetchedContent !== undefined && (
            <>
              {entry.fetchedContent ? (
                <UnchangedScriptViewer
                  name={entry.name}
                  content={entry.fetchedFilename
                    ? formatForDisplay(entry.fetchedContent, entry.fetchedFilename)
                    : entry.fetchedContent}
                />
              ) : (
                <p className="px-3 text-[10px] text-slate-400 italic">No content</p>
              )}
            </>
          )}

          {/* Changed script — render diff for each file */}
          {(entry.configFile || entry.contentFile) && [
            ...(entry.configFile  ? [entry.configFile]  : []),
            ...(entry.contentFile ? [entry.contentFile] : []),
          ].map((f) => (
            <ScriptFileEntry key={f.relativePath} f={f} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── NodeDetailPanel ────────────────────────────────────────────────────────────

function NodeDetailPanel({
  nodeId, nodeLabel, nodeType, diffStatus, modifiedReason,
  graphEdges, graphNodeLabels,
  journeyName, files, sourceEnv, targetEnv,
  navigating, onNavigateInto, onClose,
}: {
  nodeId: string;
  nodeLabel: string;
  nodeType?: string;
  diffStatus: DiffStatus;
  modifiedReason?: "script" | "subjourney";
  graphEdges: Edge[];
  graphNodeLabels: Map<string, string>;
  journeyName: string;
  files: FileDiff[];
  sourceEnv: string;
  targetEnv: string;
  navigating: boolean;
  onNavigateInto: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab]                     = useState<"config" | "scripts">("config");
  const [config, setConfig]               = useState<Record<string, unknown> | null>(null);
  const [configLoading, setConfigLoading] = useState(false);

  const isStaticNode   = nodeId === "startNode" || nodeId === DIFF_SUCCESS_ID || nodeId === DIFF_FAILURE_ID;
  const isScriptNode   = nodeType === "ScriptedDecisionNode";

  // Reset tab when node changes; don't leave on scripts tab if new node isn't a script node
  useEffect(() => { setTab("config"); setConfig(null); }, [nodeId]);

  // Fetch node config
  useEffect(() => {
    if (isStaticNode) { setConfig(null); return; }
    let cancelled = false;
    setConfigLoading(true);
    setConfig(null);

    const run = async () => {
      const fileEntry = files.find(
        (f) => f.relativePath.includes(`/${nodeId}.json`) && f.relativePath.includes("/nodes/"),
      );
      const content = fileEntry?.localContent ?? fileEntry?.remoteContent;
      if (content) {
        try { if (!cancelled) setConfig(JSON.parse(content)); } catch { /* ignore */ }
        if (!cancelled) setConfigLoading(false);
        return;
      }
      const env = diffStatus === "added" ? targetEnv : diffStatus === "removed" ? sourceEnv : (sourceEnv || targetEnv);
      if (!env || !journeyName) { if (!cancelled) setConfigLoading(false); return; }
      try {
        const params = new URLSearchParams({ environment: env, journey: journeyName, nodeId });
        const res = await fetch(`/api/push/journey-node?${params}`);
        if (res.ok && !cancelled) {
          const d = await res.json() as { file?: { content?: string } };
          try { setConfig(JSON.parse(d.file?.content ?? "")); } catch { setConfig(null); }
        }
      } catch { /* ignore */ }
      if (!cancelled) setConfigLoading(false);
    };
    void run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, isStaticNode, sourceEnv, targetEnv, journeyName, files]);

  // Resolve outcomes from edges
  const outcomes = useMemo(() =>
    graphEdges
      .filter((e) => e.source === nodeId && e.id !== "__start__")
      .map((e) => ({
        outcomeId: typeof e.label === "string" && e.label ? e.label : "outcome",
        targetId: e.target,
        targetLabel: graphNodeLabels.get(e.target) ?? e.target.slice(0, 8),
      })),
  [nodeId, graphEdges, graphNodeLabels]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start gap-2 px-3 py-2 border-b border-slate-100 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-slate-700 truncate" title={nodeLabel}>{nodeLabel}</div>
          {nodeType && (
            <div className="text-[9px] text-slate-400 font-mono truncate">{nodeType}</div>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0 mt-0.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tab bar (hidden for static nodes; scripts tab only for ScriptedDecisionNode) */}
      {!isStaticNode && isScriptNode && (
        <div className="flex border-b border-slate-200 shrink-0">
          {(["config", "scripts"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2 capitalize",
                tab === t ? "border-sky-500 text-sky-700" : "border-transparent text-slate-500 hover:text-slate-700",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* Static node info */}
        {isStaticNode && (
          <div className="px-3 py-3 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Status</span>
              <DiffStatusBadge status={diffStatus} />
            </div>
            <p className="text-[9px] text-slate-400 font-mono break-all">{nodeId}</p>
          </div>
        )}

        {/* Config tab */}
        {!isStaticNode && tab === "config" && (
          <>
            {/* Status */}
            <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2 shrink-0 flex-wrap">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Status</span>
              <DiffStatusBadge status={diffStatus} />
              {modifiedReason === "script" && (
                <span className="text-[9px] font-medium text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded">script changed</span>
              )}
              {modifiedReason === "subjourney" && (
                <span className="text-[9px] font-medium text-violet-600 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">sub-journey changed</span>
              )}
            </div>

            {/* Outcomes */}
            {outcomes.length > 0 && (
              <div className="px-3 py-3 border-b border-slate-100">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Outcomes</p>
                <div className="space-y-2">
                  {outcomes.map(({ outcomeId, targetLabel }) => (
                    <div key={outcomeId} className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 shrink-0">{outcomeId}</span>
                      <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                      <span className="text-[11px] text-slate-700 truncate">{targetLabel}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Descend into inner journey */}
            {nodeType === "InnerTreeEvaluatorNode" && (
              <div className="px-3 py-3 border-b border-slate-100">
                <button
                  type="button"
                  disabled={navigating}
                  onClick={() => onNavigateInto(nodeId)}
                  className="w-full flex items-center gap-2 text-[11px] font-medium text-sky-700 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg px-3 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {navigating ? (
                    <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                  )}
                  <span className="flex-1 text-left">{navigating ? "Loading…" : "Descend into journey"}</span>
                  {typeof config?.tree === "string" && config.tree && (
                    <span className="font-mono text-[10px] text-sky-400 truncate max-w-[100px]">{config.tree}</span>
                  )}
                </button>
              </div>
            )}

            {/* Configuration properties */}
            <div className="px-3 py-3">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Configuration</p>
              {configLoading && <p className="text-[11px] text-slate-400">Loading…</p>}
              {!configLoading && config && <PropertyTable config={config} />}
              {!configLoading && !config && <p className="text-[11px] text-slate-400">No configuration file found</p>}
            </div>
          </>
        )}

        {/* Scripts tab */}
        {!isStaticNode && tab === "scripts" && (
          <ScriptPanelContent
            nodeId={nodeId}
            nodeType={nodeType}
            journeyName={journeyName}
            diffStatus={diffStatus}
            files={files}
            sourceEnv={sourceEnv}
            targetEnv={targetEnv}
          />
        )}
      </div>
    </div>
  );
}


// ── PreviewDiffJourneyGraph ───────────────────────────────────────────────────

/** Renders a merged diff graph for an inner journey inside the preview modal. */
function PreviewDiffJourneyGraph({ localContent, remoteContent }: { localContent?: string; remoteContent?: string }) {
  const { nodes, edges } = useMemo(
    () => parseMergedDiffGraph(localContent, remoteContent, new Map()),
    [localContent, remoteContent],
  );
  return (
    <DiffGraphCanvas
      baseNodes={nodes}
      baseEdges={edges}
      nodeTypes={nodeTypes}
      applyLayout={applyLayout}
      applyCompactLayout={applyCompactLayout}
      miniMapNodeColor={journeyMiniMapNodeColor}
      legend={<DiffLegend />}
      hideUnchanged={false}
      isCompact={false}
      fitKey={0}
      externalViewport={null}
      onViewportChange={() => {}}
      searchQuery=""
      flashNodeId={null}
      zoomToNodeId={null}
    />
  );
}

// ── ScriptDiffView ────────────────────────────────────────────────────────────

/** Unified diff view with context lines collapsed by default. */
function ScriptDiffView({ lines }: { lines: DiffLineLocal[] }) {
  const CONTEXT = 3;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());

  const defaultVisible = useMemo(() => {
    const s = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type !== "context") {
        for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) {
          s.add(j);
        }
      }
    }
    return s;
  }, [lines]);

  const visibleSet = useMemo(() => {
    if (defaultVisible.size === 0) return null; // all context — show everything
    const s = new Set(defaultVisible);
    for (const idx of expandedLines) s.add(idx);
    return s;
  }, [defaultVisible, expandedLines]);

  const items = useMemo(() => {
    type Item =
      | { kind: "line"; line: DiffLineLocal; idx: number }
      | { kind: "hunk"; startIdx: number; endIdx: number };
    const result: Item[] = [];
    let i = 0;
    while (i < lines.length) {
      if (!visibleSet || visibleSet.has(i)) {
        result.push({ kind: "line", line: lines[i], idx: i });
        i++;
      } else {
        let j = i;
        while (j < lines.length && !visibleSet.has(j)) j++;
        result.push({ kind: "hunk", startIdx: i, endIdx: j - 1 });
        i = j;
      }
    }
    return result;
  }, [lines, visibleSet]);

  function expandHunk(startIdx: number, endIdx: number) {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      for (let i = startIdx; i <= endIdx; i++) next.add(i);
      return next;
    });
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-auto text-[10px] font-mono leading-5">
        <table className="min-w-full border-collapse">
          <tbody>
            {items.map((item) => {
              if (item.kind === "hunk") {
                const count = item.endIdx - item.startIdx + 1;
                return (
                  <tr key={`hunk-${item.startIdx}`} className="bg-slate-900">
                    <td colSpan={2} className="py-0.5">
                      <button
                        type="button"
                        className="w-full text-center text-[9px] text-slate-500 hover:text-slate-300 transition-colors"
                        onClick={() => expandHunk(item.startIdx, item.endIdx)}
                      >
                        ··· {count} unchanged line{count !== 1 ? "s" : ""} ···
                      </button>
                    </td>
                  </tr>
                );
              }
              const { line, idx } = item;
              const bg       = line.type === "added" ? "bg-emerald-950" : line.type === "removed" ? "bg-red-950" : "";
              const text     = line.type === "added" ? "text-emerald-300" : line.type === "removed" ? "text-red-300" : "text-slate-400";
              const pfx      = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
              const pfxColor = line.type === "added" ? "text-emerald-400" : line.type === "removed" ? "text-red-400" : "text-slate-600";
              return (
                <tr key={idx} className={bg}>
                  <td className={cn("px-1 py-0 select-none w-4 shrink-0", pfxColor)}>{pfx}</td>
                  <td
                    className={cn("px-2 py-0 whitespace-pre", text)}
                    dangerouslySetInnerHTML={{ __html: highlightLine(line.content) }}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DiffMinimap lines={lines} scrollRef={scrollRef} />
    </div>
  );
}

// ── JourneyDiffGraphModal ─────────────────────────────────────────────────────

export interface NavEntry {
  name: string;
  localContent?: string;
  remoteContent?: string;
  nodeInfos: JourneyNodeInfo[];
  sourceNodeId?: string;  // which node was clicked to navigate here
}

export interface JourneyDiffGraphModalProps {
  journeyName: string;
  localContent?: string;
  remoteContent?: string;
  nodeInfos: JourneyNodeInfo[];
  sourceLabel: string;
  targetLabel: string;
  sourceEnv: string;
  targetEnv: string;
  files: FileDiff[];
  /** Pre-populate the nav stack with ancestor journeys so the user can navigate back up. */
  ancestorPath?: NavEntry[];
  /** When set, the modal will zoom to and activate this node once the graph loads. */
  initialFocusNodeId?: string;
  onClose: () => void;
}

export function JourneyDiffGraphModal({
  journeyName,
  localContent,
  remoteContent,
  nodeInfos,
  sourceLabel,
  targetLabel,
  sourceEnv,
  targetEnv,
  files,
  ancestorPath,
  initialFocusNodeId,
  onClose,
}: JourneyDiffGraphModalProps) {
  const [viewMode, setViewMode]             = useState<"merged" | "side-by-side">("merged");
  const [displayView, setDisplayView]       = useState<"graph" | "outline" | "table" | "swimlane" | "json">("graph");
  const [hideUnchanged, setHideUnchanged]   = useState(false);
  const [isCompact, setIsCompact]           = useState(false);
  const [syncViewports, setSyncViewports]   = useState(true);
  const [fitKey, setFitKey]                 = useState(0);
  // navStack holds ALL levels: [ancestors..., current]. It always has at least one entry.
  const [navStack, setNavStack]             = useState<NavEntry[]>(() => [
    ...(ancestorPath ?? []),
    { name: journeyName, localContent, remoteContent, nodeInfos },
  ]);
  const [navigating, setNavigating]         = useState(false);
  const [activeNode, setActiveNode]         = useState<{
    id: string;
    label: string;
    nodeType?: string;
    diffStatus: DiffStatus;
    modifiedReason?: "script" | "subjourney";
  } | null>(null);
  const [previewModal, setPreviewModal]     = useState<{
    nodeId: string;
    nodeType: "ScriptedDecisionNode" | "InnerTreeEvaluatorNode";
    title: string;
    loading: boolean;
    // Script preview — diff when changed, single content when unchanged
    scriptName?: string;
    scriptContent?: string;          // unchanged script (API fallback)
    scriptDiffLines?: DiffLineLocal[];  // diff lines when script was changed
    scriptRemoteContent?: string;    // remote/new script content (for copy/fullscreen)
    scriptConfigFile?: FileDiff;     // config file (if changed) for Files tab
    scriptContentFile?: FileDiff;    // content file for Files tab
    scriptTab?: "diff" | "files";    // active tab when scriptDiffLines is set
    scriptCopied?: boolean;
    scriptFullscreen?: boolean;
    // Inner journey preview
    innerJourneyId?: string;
    innerLocalContent?: string;
    innerRemoteContent?: string;
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

  const [searchQuery, setSearchQuery]   = useState("");
  const [flashNodeId, setFlashNodeId]   = useState<string | null>(null);
  // Ref-based focus: applied once when mergedNodes first contains the target node
  const initialFocusApplied = useRef(false);
  const [zoomToNodeId, setZoomToNodeId] = useState<string | null>(null);

  const [leftExternalVP,  setLeftExternalVP]  = useState<Viewport | null>(null);
  const [rightExternalVP, setRightExternalVP] = useState<Viewport | null>(null);
  const syncSource = useRef<"left" | "right" | null>(null);

  // Active journey is always the last entry in the stack.
  const active = navStack[navStack.length - 1] ?? { name: journeyName, localContent, remoteContent, nodeInfos };

  const hasContent = !!(active.localContent || active.remoteContent);
  const nodesOnly  = !hasContent && active.nodeInfos.length > 0;

  // When the active journey has no content (unchanged journey not included in diff),
  // fetch from the API so wiring/edges can be rendered.
  useEffect(() => {
    if (hasContent) return;
    const env = sourceEnv || targetEnv;
    if (!env) return;
    const name = active.name;
    let cancelled = false;
    const fetchContent = async () => {
      try {
        const params = new URLSearchParams({ environment: env, scope: "journeys", item: name });
        const res = await fetch(`/api/push/item?${params}`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as { files?: Array<{ content?: string }> };
        const content = data.files?.[0]?.content;
        if (!content || cancelled) return;
        // Update the active entry in navStack with the fetched content on both sides
        // (unchanged journey is identical on both sides).
        setNavStack((prev) => prev.map((entry, i) =>
          i === prev.length - 1
            ? { ...entry, localContent: content, remoteContent: content }
            : entry,
        ));
      } catch { /* ignore */ }
    };
    void fetchContent();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.name, hasContent, sourceEnv, targetEnv]);

  // ESC closes preview modal first, then pops nav stack (or closes modal when at root)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (previewModal) { setPreviewModal(null); return; }
        if (navStack.length > 1) {
          setNavStack((s) => s.slice(0, -1));
          setActiveNode(null);
          setFitKey((k) => k + 1);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, navStack.length, previewModal]);

  const clearFocusNode = useCallback(() => setFlashNodeId(null), []);

  // Fetch preview content when modal opens
  useEffect(() => {
    if (!previewModal?.loading) return;
    // Try target first, fall back to source — ensures source-only items (target deleted)
    // still preview correctly.
    const envCandidates = [targetEnv, sourceEnv].filter((e): e is string => !!e);
    if (envCandidates.length === 0) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }
    const { nodeId, nodeType } = previewModal;
    let cancelled = false;

    const fetchNodeConfigFromEnv = async (env: string): Promise<Record<string, unknown> | null> => {
      try {
        const params = new URLSearchParams({ environment: env, journey: active.name, nodeId });
        const res = await fetch(`/api/push/journey-node?${params}`);
        if (!res.ok) return null;
        const d = await res.json() as { file?: { content?: string } };
        if (!d.file?.content) return null;
        try { return JSON.parse(d.file.content) as Record<string, unknown>; } catch { return null; }
      } catch { return null; }
    };

    const fetchScriptFromEnv = async (env: string, scriptId: string) => {
      try {
        const sParams = new URLSearchParams({ environment: env, scriptId });
        const sRes = await fetch(`/api/push/script?${sParams}`);
        if (!sRes.ok) return null;
        return await sRes.json() as { name?: string; content?: string | null; filename?: string };
      } catch { return null; }
    };

    const doFetch = async () => {
      try {
        // Resolve node config — files array first, then API fallback (target→source)
        const nodeConfigFile = files.find(
          (f) => f.relativePath.includes(`/${nodeId}.json`) && f.relativePath.includes("/nodes/"),
        );
        let config: Record<string, unknown> | null = null;
        if (nodeConfigFile) {
          const content = nodeConfigFile.remoteContent ?? nodeConfigFile.localContent;
          if (content) { try { config = JSON.parse(content) as Record<string, unknown>; } catch { /* ignore */ } }
        }
        for (const env of envCandidates) {
          if (config || cancelled) break;
          config = await fetchNodeConfigFromEnv(env);
        }
        if (cancelled) return;
        if (!config) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }

        if (nodeType === "ScriptedDecisionNode") {
          // `config.script` is the script UUID for ScriptedDecisionNode
          const scriptId = typeof config?.script === "string" ? config.script : null;
          if (!scriptId || cancelled) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }

          // Step 1: resolve script name / content by trying each env in order.
          // For source-only items (target has deleted them), target returns 404 and we
          // transparently fall back to source.
          let scriptName: string = scriptId;
          let scriptFilename: string | undefined;
          let scriptFullFilename: string | undefined;
          let apiFallbackContent: string | undefined;
          for (const env of envCandidates) {
            if (cancelled) return;
            const sd = await fetchScriptFromEnv(env, scriptId);
            if (!sd) continue;
            if (sd.name) scriptName = sd.name;
            if (sd.filename) {
              scriptFullFilename = sd.filename;
              scriptFilename = sd.filename.replace(/\.[^.]+$/, "");
            }
            if (sd.content != null) {
              apiFallbackContent = scriptFullFilename
                ? formatForDisplay(sd.content, scriptFullFilename)
                : sd.content;
              break;
            }
          }
          if (cancelled) return;

          // Step 2: look for a diff content file in `files` using the script filename
          // (the display name from sd.name may not match the actual filename on disk)
          let scriptDiffLines: DiffLineLocal[] | undefined;
          let scriptRemoteContent: string | undefined;
          const contentFile = files.find(
            (f) => f.relativePath.includes("/scripts-content/") && (() => {
              const base = f.relativePath.split("/").pop()?.replace(/\.[^.]+$/, "");
              return base === scriptFilename || base === scriptName;
            })(),
          );
          if (contentFile) {
            const cfLocal  = contentFile.localContent  != null ? formatForDisplay(contentFile.localContent,  contentFile.relativePath) : null;
            const cfRemote = contentFile.remoteContent != null ? formatForDisplay(contentFile.remoteContent, contentFile.relativePath) : null;
            scriptRemoteContent = cfRemote ?? undefined;
            if (cfLocal != null && cfRemote != null) {
              scriptDiffLines = clientDiff(cfLocal, cfRemote);
            } else if (cfRemote != null) {
              scriptDiffLines = cfRemote.split("\n").map((c) => ({ type: "added" as const, content: c }));
            } else if (cfLocal != null) {
              scriptDiffLines = cfLocal.split("\n").map((c) => ({ type: "removed" as const, content: c }));
            } else if (contentFile.diffLines && contentFile.diffLines.length > 0) {
              scriptDiffLines = contentFile.diffLines as DiffLineLocal[];
            }
          }

          const scriptConfigFile = files.find((f) => f.relativePath.includes(`/scripts-config/${scriptId}.json`));

          if (scriptDiffLines) {
            setPreviewModal((p) => p ? { ...p, loading: false, scriptName, scriptDiffLines, scriptRemoteContent, scriptConfigFile, scriptContentFile: contentFile } : null);
          } else {
            // No diff found — show content fetched from API (unchanged or config-only change)
            setPreviewModal((p) => p ? { ...p, loading: false, scriptName, scriptContent: apiFallbackContent, scriptConfigFile, scriptContentFile: contentFile } : null);
          }

        } else {
          // InnerTreeEvaluatorNode — fetch both sides for diff graph
          const treeId = typeof config?.tree === "string" ? config.tree : null;
          if (!treeId || cancelled) { setPreviewModal((p) => p ? { ...p, loading: false } : null); return; }

          const subFile = files.find((f) => f.relativePath.endsWith(`/journeys/${treeId}/${treeId}.json`));
          let innerLocalContent  = subFile?.localContent;
          let innerRemoteContent = subFile?.remoteContent;

          const fetchSide = async (sideEnv: string): Promise<string | undefined> => {
            try {
              const p = new URLSearchParams({ environment: sideEnv, scope: "journeys", item: treeId });
              const r = await fetch(`/api/push/item?${p}`);
              if (!r.ok) return undefined;
              const d = await r.json() as { files?: Array<{ content?: string }> };
              return d.files?.[0]?.content;
            } catch { return undefined; }
          };

          if (!innerLocalContent  && sourceEnv) innerLocalContent  = await fetchSide(sourceEnv);
          if (!innerRemoteContent && targetEnv) innerRemoteContent = await fetchSide(targetEnv);
          if (cancelled) return;
          setPreviewModal((p) => p ? { ...p, loading: false, innerJourneyId: treeId, innerLocalContent, innerRemoteContent } : null);
        }
      } catch {
        if (!cancelled) setPreviewModal((p) => p ? { ...p, loading: false } : null);
      }
    };

    void doFetch();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewModal?.nodeId, previewModal?.loading]);

  // Fetch PageNode configs and ScriptedDecisionNode script names for the active journey
  const [pageConfigs, setPageConfigs] = useState<Map<string, PageNodeConfig>>(new Map());
  const [scriptNames, setScriptNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    setPageConfigs(new Map());
    setScriptNames(new Map());
    const content = active.remoteContent ?? active.localContent;
    if (!content) return;
    const env = targetEnv || sourceEnv;
    if (!env) return;

    let pageNodeIds: string[] = [];
    let scriptNodeIds: string[] = [];
    try {
      const data = JSON.parse(content) as { nodes?: Record<string, { nodeType?: string }> };
      const entries = Object.entries(data.nodes ?? {});
      pageNodeIds   = entries.filter(([, n]) => n.nodeType === "PageNode").map(([id]) => id);
      scriptNodeIds = entries.filter(([, n]) => n.nodeType === "ScriptedDecisionNode").map(([id]) => id);
    } catch { /* ignore */ }

    let cancelled = false;

    // Page configs
    if (pageNodeIds.length > 0) {
      Promise.all(
        pageNodeIds.map(async (nodeId) => {
          const params = new URLSearchParams({ environment: env, journey: active.name, nodeId });
          try {
            const res = await fetch(`/api/push/journey-node?${params}`);
            if (!res.ok) return null;
            const d = await res.json() as { file?: { content?: string } };
            if (!d.file?.content) return null;
            return [nodeId, JSON.parse(d.file.content) as PageNodeConfig] as const;
          } catch { return null; }
        })
      ).then((entries) => {
        if (cancelled) return;
        setPageConfigs(new Map(entries.filter((e): e is [string, PageNodeConfig] => e !== null)));
      });
    }

    // Script names for search
    if (scriptNodeIds.length > 0) {
      Promise.all(
        scriptNodeIds.map(async (nodeId) => {
          try {
            const params = new URLSearchParams({ environment: env, journey: active.name, nodeId });
            const res = await fetch(`/api/push/journey-node?${params}`);
            if (!res.ok) return null;
            const d = await res.json() as { file?: { content?: string } };
            if (!d.file?.content) return null;
            const config = JSON.parse(d.file.content) as Record<string, unknown>;
            const scriptId = typeof config.script === "string" ? config.script : null;
            if (!scriptId) return null;
            const sParams = new URLSearchParams({ environment: env, scriptId });
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
    }

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.name, active.remoteContent, active.localContent, sourceEnv, targetEnv]);

  // Build nodeStatusMap and nodeModifiedReasonMap
  const nodeStatusMap = useMemo(() => {
    const m = new Map<string, DiffStatus>();
    for (const n of active.nodeInfos) m.set(n.uuid, n.status as DiffStatus);
    return m;
  }, [active.nodeInfos]);

  const nodeModifiedReasonMap = useMemo(() => {
    const m = new Map<string, "script" | "subjourney">();
    for (const n of active.nodeInfos) {
      if (n.modifiedReason) m.set(n.uuid, n.modifiedReason);
    }
    return m;
  }, [active.nodeInfos]);

  // Build all graphs
  const { mergedNodes, mergedEdges, localNodes, localEdges, remoteNodes, remoteEdges } =
    useMemo(() => {
      if (!hasContent) {
        const { nodes, edges } = parseNodesOnlyGraph(
          active.nodeInfos.map((n) => ({ ...n, status: n.status as DiffStatus })),
        );
        // Inject modifiedReason into fallback nodes too
        for (const node of nodes) {
          const reason = nodeModifiedReasonMap.get(node.id);
          if (reason) node.data = { ...node.data, modifiedReason: reason };
        }
        return {
          mergedNodes: nodes, mergedEdges: edges,
          localNodes:  nodes, localEdges:  edges,
          remoteNodes: nodes, remoteEdges: edges,
        };
      }

      const pc = pageConfigs.size > 0 ? pageConfigs : undefined;
      const merged = parseMergedDiffGraph(active.localContent, active.remoteContent, nodeStatusMap, nodeModifiedReasonMap, pc);
      const local  = active.localContent
        ? parseSingleSideGraph(active.localContent,  nodeStatusMap, "local",  nodeModifiedReasonMap, pc)
        : { nodes: [] as Node[], edges: [] as Edge[] };
      const remote = active.remoteContent
        ? parseSingleSideGraph(active.remoteContent, nodeStatusMap, "remote", nodeModifiedReasonMap, pc)
        : { nodes: [] as Node[], edges: [] as Edge[] };

      return {
        mergedNodes: merged.nodes, mergedEdges: merged.edges,
        localNodes:  local.nodes,  localEdges:  local.edges,
        remoteNodes: remote.nodes, remoteEdges: remote.edges,
      };
    }, [hasContent, active.localContent, active.remoteContent, active.nodeInfos, nodeStatusMap, nodeModifiedReasonMap, pageConfigs]);

  const graphNodeLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of mergedNodes) {
      const label = typeof n.data.label === "string" ? n.data.label : n.id;
      map.set(n.id, label);
    }
    return map;
  }, [mergedNodes]);

  // Ordered list of top-level match IDs for prev/next search navigation
  const searchMatchIds = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    const matchSet = new Set<string>();
    for (const n of mergedNodes) {
      const labelMatch  = String(n.data.label ?? "").toLowerCase().includes(q);
      const scriptMatch = n.data.nodeType === "ScriptedDecisionNode" &&
        (scriptNames.get(n.id) ?? "").toLowerCase().includes(q);
      if (labelMatch || scriptMatch) {
        if (!n.parentId) matchSet.add(n.id);
        else             matchSet.add(n.parentId);
      }
    }
    return mergedNodes.filter((n) => !n.parentId && matchSet.has(n.id)).map((n) => n.id);
  }, [searchQuery, mergedNodes, scriptNames]);

  const [searchIndex, setSearchIndex] = useState(0);
  useEffect(() => {
    setSearchIndex(0);
    setZoomToNodeId(searchMatchIds[0] ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatchIds]);

  const goSearchPrev = useCallback(() => {
    const next = (searchIndex - 1 + searchMatchIds.length) % searchMatchIds.length;
    setSearchIndex(next);
    setZoomToNodeId(searchMatchIds[next] ?? null);
  }, [searchIndex, searchMatchIds]);

  const goSearchNext = useCallback(() => {
    const next = (searchIndex + 1) % searchMatchIds.length;
    setSearchIndex(next);
    setZoomToNodeId(searchMatchIds[next] ?? null);
  }, [searchIndex, searchMatchIds]);

  // When mergedNodes is ready and contains the initial focus node, activate + zoom to it (once)
  useEffect(() => {
    if (initialFocusApplied.current || !initialFocusNodeId || mergedNodes.length === 0) return;
    const node = mergedNodes.find((n) => n.id === initialFocusNodeId);
    if (!node) return; // not yet in mergedNodes — retry on next change
    initialFocusApplied.current = true;
    setActiveNode({
      id: node.id,
      label: typeof node.data.label === "string" ? node.data.label : node.id,
      nodeType: typeof node.data.nodeType === "string" ? node.data.nodeType : undefined,
      diffStatus: (node.data.diffStatus as DiffStatus) ?? "unchanged",
      modifiedReason: node.data.modifiedReason as "script" | "subjourney" | undefined,
    });
    setFlashNodeId(initialFocusNodeId);
    setZoomToNodeId(initialFocusNodeId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFocusNodeId, mergedNodes]);

  const handleLeftMove = useCallback((vp: Viewport) => {
    if (!syncViewports || syncSource.current === "left") return;
    syncSource.current = "right";
    setRightExternalVP(vp);
    setTimeout(() => { syncSource.current = null; }, 150);
  }, [syncViewports]);

  const handleRightMove = useCallback((vp: Viewport) => {
    if (!syncViewports || syncSource.current === "right") return;
    syncSource.current = "left";
    setLeftExternalVP(vp);
    setTimeout(() => { syncSource.current = null; }, 150);
  }, [syncViewports]);

  // Navigate into an inner journey
  const navigateInto = useCallback(async (nodeId: string, _nodeData: Record<string, unknown>) => {
    setNavigating(true);
    try {
      // Step 1: get the real tree name from the node config.
      // Try FileDiff first (works when node config was changed), then fall back to the
      // journey-node API (works for unchanged node configs).
      let treeName: string | null = null;

      const nodeConfigFile = files.find(
        (f) => f.relativePath.includes(`/${nodeId}.json`) && f.relativePath.includes("/nodes/"),
      );
      if (nodeConfigFile) {
        const content = nodeConfigFile.localContent ?? nodeConfigFile.remoteContent;
        if (content) {
          try {
            const json = JSON.parse(content) as Record<string, unknown>;
            if (typeof json.tree === "string" && json.tree) treeName = json.tree;
          } catch { /* ignore */ }
        }
      }

      if (!treeName) {
        // Fetch node config via API. Try each env in order — an added inner
        // tree evaluator may live on only one side, and the parent journey
        // may exist on only one side too, so probing just one env silently
        // fails when we probe the wrong one.
        const envCandidates = [sourceEnv, targetEnv].filter((e): e is string => !!e);
        for (const env of envCandidates) {
          if (treeName) break;
          try {
            const params = new URLSearchParams({ environment: env, journey: active.name, nodeId });
            const res = await fetch(`/api/push/journey-node?${params}`);
            if (!res.ok) continue;
            const data = await res.json() as { file?: { content?: string } };
            if (!data.file?.content) continue;
            const json = JSON.parse(data.file.content) as Record<string, unknown>;
            if (typeof json.tree === "string" && json.tree) treeName = json.tree;
          } catch { /* try next */ }
        }
      }

      if (!treeName) return; // can't determine sub-journey name

      // Step 2: find sub-journey JSON from already-loaded files (works for changed journeys)
      const subFile = files.find((f) => f.relativePath.endsWith(`/journeys/${treeName}/${treeName}.json`));
      let subLocalContent  = subFile?.localContent;
      let subRemoteContent = subFile?.remoteContent;

      // Step 3: fetch content from both environments when not available in files
      const fetchJourney = async (env: string): Promise<string | undefined> => {
        try {
          const params = new URLSearchParams({ environment: env, scope: "journeys", item: treeName! });
          const res = await fetch(`/api/push/item?${params}`);
          if (!res.ok) return undefined;
          const data = await res.json() as { files?: Array<{ content?: string }> };
          return data.files?.[0]?.content ?? undefined;
        } catch { return undefined; }
      };

      if (!subLocalContent  && sourceEnv) subLocalContent  = await fetchJourney(sourceEnv);
      if (!subRemoteContent && targetEnv) subRemoteContent = await fetchJourney(targetEnv);

      setNavStack((prev) => [...prev, {
        name: treeName!,
        localContent:  subLocalContent,
        remoteContent: subRemoteContent,
        nodeInfos:     [],
        sourceNodeId:  nodeId,
      }]);
      setActiveNode(null);
      setFitKey((k) => k + 1);
    } finally {
      setNavigating(false);
    }
  }, [files, sourceEnv, targetEnv, active.name]);

  // Handle node activate from canvas (single click → side panel only)
  const handleNodeActivate = useCallback((nodeId: string | null, nodeData: Record<string, unknown>) => {
    if (!nodeId) {
      setActiveNode(null);
      return;
    }
    const label       = typeof nodeData.label    === "string" ? nodeData.label    : nodeId;
    const nodeType    = typeof nodeData.nodeType === "string" ? nodeData.nodeType : undefined;
    const diffStatus  = (nodeData.diffStatus as DiffStatus) ?? "unchanged";
    const modifiedReason = (nodeData.modifiedReason as "script" | "subjourney" | undefined);
    const panelId = nodeId.includes("__child__") ? nodeId.split("__child__").pop()! : nodeId;
    setActiveNode({ id: panelId, label, nodeType, diffStatus, modifiedReason });
  }, []);

  // Handle node double-click from canvas (double click → preview modal + side panel)
  const handleNodeDoubleActivate = useCallback((nodeId: string, nodeData: Record<string, unknown>) => {
    const label    = typeof nodeData.label    === "string" ? nodeData.label    : nodeId;
    const nodeType = typeof nodeData.nodeType === "string" ? nodeData.nodeType : undefined;

    if (nodeType === "ScriptedDecisionNode" || nodeType === "InnerTreeEvaluatorNode") {
      const realId = nodeId.includes("__child__") ? nodeId.split("__child__").pop()! : nodeId;
      setPreviewModal({ nodeId: realId, nodeType, title: label, loading: true });
    }

    // Also open/update the side panel
    const diffStatus     = (nodeData.diffStatus as DiffStatus) ?? "unchanged";
    const modifiedReason = (nodeData.modifiedReason as "script" | "subjourney" | undefined);
    const panelId = nodeId.includes("__child__") ? nodeId.split("__child__").pop()! : nodeId;
    setActiveNode({ id: panelId, label, nodeType, diffStatus, modifiedReason });
  }, []);

  const showSidePanel = !!activeNode;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-white overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-slate-200 shrink-0">
        {/* Breadcrumb */}
        <div className="flex-1 min-w-0">
          {navStack.length <= 1 ? (
            <span className="text-sm font-semibold text-slate-800 truncate" title={navStack[0]?.name ?? journeyName}>
              {navStack[0]?.name ?? journeyName}
            </span>
          ) : (
            <nav className="flex items-center gap-1 text-sm min-w-0 flex-wrap">
              {navStack.map((entry, i) => (
                <Fragment key={`${entry.name}-${i}`}>
                  {i > 0 && <span className="text-slate-400 shrink-0">›</span>}
                  {i < navStack.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        const flashTarget = navStack[i + 1]?.sourceNodeId ?? null;
                        setNavStack((prev) => prev.slice(0, i + 1));
                        setActiveNode(null);
                        setFitKey((k) => k + 1);
                        if (flashTarget) setFlashNodeId(flashTarget);
                      }}
                      className={cn("hover:text-sky-800 truncate max-w-[150px] shrink-0 text-sky-600", i === 0 && "font-semibold")}
                    >
                      {entry.name}
                    </button>
                  ) : (
                    <span className="font-semibold text-slate-800 truncate max-w-[150px]">{entry.name}</span>
                  )}
                </Fragment>
              ))}
            </nav>
          )}
        </div>

        {nodesOnly && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">
            nodes only
          </span>
        )}

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
                {searchMatchIds.length > 1 ? `${searchIndex + 1} / ${searchMatchIds.length}` : `${searchMatchIds.length} match${searchMatchIds.length !== 1 ? "es" : ""}`}
              </span>
              <button type="button" onClick={() => { setSearchQuery(""); setZoomToNodeId(null); }} title="Clear search" className="text-slate-400 hover:text-slate-600 shrink-0">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {searchMatchIds.length > 1 && (
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
                "px-2.5 py-1 transition-colors capitalize",
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
          {/* View mode toggle */}
          <div className="flex rounded border border-slate-300 overflow-hidden text-[11px] shrink-0">
            {(["merged", "side-by-side"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                className={cn(
                  "px-3 py-1 transition-colors capitalize",
                  viewMode === m
                    ? "bg-slate-600 text-white"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
                )}
              >
                {m === "side-by-side" ? "Side by side" : "Merged"}
              </button>
            ))}
          </div>

          {/* Hide unchanged */}
          <button
            type="button"
            onClick={() => setHideUnchanged((v) => !v)}
            title="Hide unchanged nodes"
            className={cn(
              "px-2.5 py-1 text-[11px] rounded border transition-colors shrink-0",
              hideUnchanged
                ? "bg-sky-600 text-white border-sky-600"
                : "text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400",
            )}
          >
            Hide unchanged
          </button>

          {/* Compact layout */}
          <button
            type="button"
            onClick={() => setIsCompact((v) => !v)}
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

          {/* Sync viewports (side-by-side only) */}
          {viewMode === "side-by-side" && (
            <button
              type="button"
              onClick={() => setSyncViewports((v) => !v)}
              title="Sync viewports between panels"
              className={cn(
                "px-2.5 py-1 text-[11px] rounded border transition-colors shrink-0",
                syncViewports
                  ? "bg-sky-600 text-white border-sky-600"
                  : "text-slate-500 border-slate-300 hover:text-slate-700 hover:border-slate-400",
              )}
            >
              Sync viewports
            </button>
          )}
        </>)}

        {/* Fit view */}
        <button
          type="button"
          onClick={() => setFitKey((k) => k + 1)}
          title="Fit view"
          className="text-slate-400 hover:text-sky-600 transition-colors shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
          </svg>
        </button>

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="text-slate-400 hover:text-slate-700 transition-colors shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 flex">
        {/* Main view area */}
        <div className="flex-1 min-w-0 flex overflow-hidden">
          {displayView !== "graph" ? (
            /* Alternate views — show target (remote) content */
            (() => {
              const json = active.remoteContent ?? active.localContent ?? "";
              const env  = targetEnv || sourceEnv;
              if (!json) return <div className="flex items-center justify-center h-full text-sm text-slate-400">No content available</div>;
              if (displayView === "outline")  return <div className="flex-1 overflow-auto"><JourneyOutlineView  json={json} /></div>;
              if (displayView === "table")    return <div className="flex-1 overflow-auto"><JourneyTableView    json={json} environment={env} journeyId={active.name} /></div>;
              if (displayView === "swimlane") return <div className="flex-1 overflow-auto"><JourneySwimLaneView json={json} /></div>;
              if (displayView === "json") return (
                <div className="flex-1 overflow-auto bg-slate-950 p-4">
                  <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all">{json}</pre>
                </div>
              );
              return null;
            })()
          ) : viewMode === "merged" ? (
            <DiffGraphCanvas
              className="flex-1"
              baseNodes={mergedNodes}
              baseEdges={mergedEdges}
              nodeTypes={nodeTypes}
              applyLayout={applyLayout}
              applyCompactLayout={applyCompactLayout}
              miniMapNodeColor={journeyMiniMapNodeColor}
              legend={<DiffLegend />}
              hideUnchanged={hideUnchanged}
              isCompact={isCompact}
              fitKey={fitKey}
              externalViewport={null}
              onViewportChange={() => {}}
              onNodeActivate={handleNodeActivate}
              onNodeDoubleClick={handleNodeDoubleActivate}
              searchQuery={searchQuery}
              flashNodeId={flashNodeId}
              onPaneClearFocus={clearFocusNode}
              zoomToNodeId={zoomToNodeId}
              scriptNames={scriptNames}
            />
          ) : (
            <>
              {/* Left panel (local / source) */}
              <div className="flex-1 min-w-0 relative border-r border-slate-200">
                <span className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-white/90 text-slate-600 text-[10px] px-2 py-1 rounded border border-slate-200 shadow-sm pointer-events-none">
                  {sourceLabel}
                </span>
                <DiffGraphCanvas
                  baseNodes={localNodes}
                  baseEdges={localEdges}
                  nodeTypes={nodeTypes}
                  applyLayout={applyLayout}
                  applyCompactLayout={applyCompactLayout}
                  miniMapNodeColor={journeyMiniMapNodeColor}
                  legend={<DiffLegend />}
                  hideUnchanged={hideUnchanged}
                  isCompact={isCompact}
                  fitKey={fitKey}
                  externalViewport={leftExternalVP}
                  onViewportChange={handleLeftMove}
                  onNodeActivate={handleNodeActivate}
                  onNodeDoubleClick={handleNodeDoubleActivate}
                  searchQuery={searchQuery}
                  flashNodeId={flashNodeId}
                  onPaneClearFocus={clearFocusNode}
                  zoomToNodeId={zoomToNodeId}
                  scriptNames={scriptNames}
                />
              </div>

              {/* Right panel (remote / target) */}
              <div className="flex-1 min-w-0 relative">
                <span className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-white/90 text-slate-600 text-[10px] px-2 py-1 rounded border border-slate-200 shadow-sm pointer-events-none">
                  {targetLabel}
                </span>
                <DiffGraphCanvas
                  baseNodes={remoteNodes}
                  baseEdges={remoteEdges}
                  nodeTypes={nodeTypes}
                  applyLayout={applyLayout}
                  applyCompactLayout={applyCompactLayout}
                  miniMapNodeColor={journeyMiniMapNodeColor}
                  legend={<DiffLegend />}
                  hideUnchanged={hideUnchanged}
                  isCompact={isCompact}
                  fitKey={fitKey}
                  externalViewport={rightExternalVP}
                  onViewportChange={handleRightMove}
                  onNodeActivate={handleNodeActivate}
                  onNodeDoubleClick={handleNodeDoubleActivate}
                  searchQuery={searchQuery}
                  flashNodeId={flashNodeId}
                  onPaneClearFocus={clearFocusNode}
                  zoomToNodeId={zoomToNodeId}
                  scriptNames={scriptNames}
                />
              </div>
            </>
          )}
        </div>

        {/* Side panel */}
        {showSidePanel && activeNode && (
          <div className="w-80 shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-hidden">
            <NodeDetailPanel
              nodeId={activeNode.id}
              nodeLabel={activeNode.label}
              nodeType={activeNode.nodeType}
              diffStatus={activeNode.diffStatus}
              modifiedReason={activeNode.modifiedReason}
              graphEdges={mergedEdges}
              graphNodeLabels={graphNodeLabels}
              journeyName={active.name}
              files={files}
              sourceEnv={sourceEnv}
              targetEnv={targetEnv}
              navigating={navigating}
              onNavigateInto={(id) => void navigateInto(id, {})}
              onClose={() => setActiveNode(null)}
            />
          </div>
        )}
      </div>

      {/* ── Preview modal (ScriptedDecisionNode / InnerTreeEvaluatorNode) ─────── */}
      {previewModal && (() => {
        // Compute copyable/fullscreen content once (remote version; reconstruct from diff if needed)
        const scriptCopyContent = previewModal.scriptRemoteContent
          ?? previewModal.scriptContent
          ?? previewModal.scriptDiffLines?.filter((l) => l.type !== "removed").map((l) => l.content).join("\n");
        const hasScriptContent = previewModal.scriptDiffLines != null || !!scriptCopyContent;
        const showFullscreen   = !!previewModal.scriptFullscreen && previewModal.nodeType === "ScriptedDecisionNode";

        const modalInner = (
          <div
            ref={modalRef}
            tabIndex={-1}
            className={cn(
              "flex flex-col overflow-hidden outline-none bg-white",
              showFullscreen
                ? "fixed inset-0 z-[70]"
                : "rounded-xl shadow-2xl",
            )}
            style={showFullscreen ? undefined : {
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
                        onClick={() => { void navigateInto(previewModal.nodeId, {}); setPreviewModal(null); }}
                        className="px-3 py-1.5 text-xs font-medium rounded border border-sky-600 text-sky-600 hover:bg-sky-50 transition-colors shrink-0"
                      >
                        Navigate into diff →
                      </button>
                    )}
                    {previewModal.nodeType === "ScriptedDecisionNode" && !previewModal.loading && previewModal.scriptDiffLines && (
                      /* Diff / Files tab switcher */
                      <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5 shrink-0">
                        {(["diff", "files"] as const).map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            onClick={() => setPreviewModal((p) => p ? { ...p, scriptTab: tab } : null)}
                            className={cn(
                              "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                              (previewModal.scriptTab ?? "diff") === tab
                                ? "bg-white text-slate-800 shadow-sm"
                                : "text-slate-500 hover:text-slate-700",
                            )}
                          >
                            {tab === "diff" ? "Diff" : "Files"}
                          </button>
                        ))}
                      </div>
                    )}
                    {previewModal.nodeType === "ScriptedDecisionNode" && !previewModal.loading && hasScriptContent && (
                      <>
                        <button
                          type="button"
                          title="Copy script"
                          onClick={() => {
                            void navigator.clipboard.writeText(scriptCopyContent ?? "").then(() => {
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
                          title={showFullscreen ? "Exit fullscreen" : "View fullscreen"}
                          onClick={() => setPreviewModal((p) => p ? { ...p, scriptFullscreen: !p.scriptFullscreen } : null)}
                          className="text-slate-400 hover:text-slate-600 shrink-0"
                        >
                          {showFullscreen ? (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 15v4.5M9 15H4.5M15 9h4.5M15 9V4.5M15 15h4.5M15 15v4.5" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                            </svg>
                          )}
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
                        {previewModal.scriptDiffLines && (previewModal.scriptTab ?? "diff") === "files" ? (
                          /* Files tab — per-file diff list */
                          <div className={cn(
                            "divide-y divide-slate-800",
                            showFullscreen
                              ? "flex-1 min-h-0 flex flex-col overflow-hidden"
                              : "flex-1 overflow-y-auto",
                          )}>
                            {[previewModal.scriptConfigFile, previewModal.scriptContentFile]
                              .filter((f): f is FileDiff => !!f && f.status !== "unchanged")
                              .map((f) => {
                                const isConfig  = f.relativePath.includes("/scripts-config/");
                                const fileLabel = f.relativePath.split("/").pop() ?? f.relativePath;
                                const statusColor = f.status === "added" ? "text-emerald-400" : f.status === "removed" ? "text-red-400" : "text-amber-400";
                                const ftLocal  = f.localContent  != null ? formatForDisplay(f.localContent,  f.relativePath) : null;
                                const ftRemote = f.remoteContent != null ? formatForDisplay(f.remoteContent, f.relativePath) : null;
                                let diffLines: DiffLineLocal[] = [];
                                if (ftLocal != null && ftRemote != null) {
                                  diffLines = clientDiff(ftLocal, ftRemote);
                                } else if (ftRemote != null) {
                                  diffLines = ftRemote.split("\n").map((c) => ({ type: "added" as const, content: c }));
                                } else if (ftLocal != null) {
                                  diffLines = ftLocal.split("\n").map((c) => ({ type: "removed" as const, content: c }));
                                } else if (f.diffLines && f.diffLines.length > 0) {
                                  diffLines = f.diffLines as DiffLineLocal[];
                                }
                                const added   = diffLines.filter((l) => l.type === "added").length;
                                const removed = diffLines.filter((l) => l.type === "removed").length;
                                return (
                                  <div key={f.relativePath} className={cn(
                                    "p-3",
                                    showFullscreen && "flex-1 min-h-0 flex flex-col overflow-hidden",
                                  )}>
                                    <div className={cn(
                                      "flex items-center gap-2 mb-1.5",
                                      showFullscreen && "shrink-0",
                                    )}>
                                      <svg className={cn("w-3 h-3 shrink-0", isConfig ? "text-slate-400" : "text-violet-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        {isConfig
                                          ? <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                                          : <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                                        }
                                      </svg>
                                      <span className="text-[10px] font-mono text-slate-300 truncate flex-1">{fileLabel}</span>
                                      <span className={cn("text-[9px] font-medium shrink-0", statusColor)}>{f.status}</span>
                                      {(added > 0 || removed > 0) && (
                                        <span className="text-[9px] text-slate-500 shrink-0">
                                          +{added} -{removed}
                                        </span>
                                      )}
                                    </div>
                                    {diffLines.length > 0 && <SplitDiffView lines={diffLines} fullscreen={showFullscreen} />}
                                  </div>
                                );
                              })}
                          </div>
                        ) : previewModal.scriptDiffLines ? (
                          /* Diff tab — collapsed unified diff */
                          <ScriptDiffView lines={previewModal.scriptDiffLines} />
                        ) : previewModal.scriptContent ? (
                          /* Unchanged script — highlighted single view */
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
                      /* Inner journey — diff graph preview */
                      (previewModal.innerLocalContent || previewModal.innerRemoteContent) ? (
                        <PreviewDiffJourneyGraph
                          localContent={previewModal.innerLocalContent}
                          remoteContent={previewModal.innerRemoteContent}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-sm text-slate-400">Could not load inner journey.</div>
                      )
                    )}
                  </div>
          </div>
        );

        return showFullscreen ? (
          modalInner
        ) : (
          <div
            className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40"
            onClick={() => setPreviewModal(null)}
          >
            {modalInner}
          </div>
        );
      })()}
    </div>
  );
}
