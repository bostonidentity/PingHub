"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Environment,
  ConfigScope,
  CONFIG_SCOPES,
  PROMOTE_SUBCOMMANDS,
  PromoteSubcommand,
} from "@/lib/fr-config-types";
import type { ScopeSelection } from "@/lib/fr-config-types";
import type { PromotionTask, TaskStatus } from "@/lib/promotion-tasks";
import { LogViewer } from "@/components/LogViewer";
import { ScopedLogViewer } from "@/components/ScopedLogViewer";
import { DiffReport } from "@/app/compare/DiffReport";
import { DangerousConfirmDialog } from "@/components/DangerousConfirmDialog";
import { useDialog } from "@/components/ConfirmDialog";
import type { PromotePrecheckResult } from "@/lib/analyze/promote-precheck";
import { useStreamingLogs, type LogEntry } from "@/hooks/useStreamingLogs";
import { useBusyState } from "@/hooks/useBusyState";
import { cn } from "@/lib/utils";

// ── Types & phase definitions ─────────────────────────────────────────────────

export type PhaseId = "dry-run" | "promote" | "summary";
export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

const PHASE_DEFS: { id: PhaseId; label: string; description: string }[] = [
  { id: "dry-run",  label: "Dry Run",  description: "Compare source vs target" },
  { id: "promote",  label: "Promote",  description: "Push, pull target & verify" },
  { id: "summary",  label: "Summary",  description: "Promotion result" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCommandType(scope: string): "fr-config" | "frodo" | "iga-api" {
  return CONFIG_SCOPES.find((s) => s.value === scope)?.commandType ?? "fr-config";
}

function scopeLabel(scope: string): string {
  return CONFIG_SCOPES.find((s) => s.value === scope)?.label ?? scope;
}

// ── Stepper ───────────────────────────────────────────────────────────────────

function Stepper({
  statuses,
  active,
  onClick,
}: {
  statuses: Record<PhaseId, PhaseStatus>;
  active: PhaseId;
  onClick: (id: PhaseId) => void;
}) {
  return (
    <div className="flex items-start overflow-x-auto pb-1">
      {PHASE_DEFS.map((phase, i) => {
        const status = statuses[phase.id];
        const isActive = phase.id === active;
        const isSkipped = status === "skipped";

        const dot = cn(
          "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 border-2 transition-colors",
          status === "done"    && "bg-emerald-500 border-emerald-500 text-white",
          status === "failed"  && "bg-red-500 border-red-500 text-white",
          status === "running" && "bg-sky-500 border-sky-500 text-white animate-pulse",
          status === "skipped" && "bg-slate-100 border-slate-200 text-slate-400",
          status === "pending" && !isActive && "bg-white border-slate-300 text-slate-400",
          status === "pending" && isActive  && "bg-sky-50 border-sky-500 text-sky-600",
        );

        return (
          <div key={phase.id} className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (isSkipped) return;
                if (phase.id === "promote" && statuses["dry-run"] !== "done" && statuses["dry-run"] !== "skipped") return;
                if (phase.id === "summary" && statuses.promote !== "done" && statuses.promote !== "failed") return;
                const summaryReached = statuses.summary === "done" || statuses.summary === "failed";
                if (summaryReached && phase.id !== "summary") return;
                onClick(phase.id);
              }}
              disabled={
                isSkipped ||
                (phase.id === "promote" && statuses["dry-run"] !== "done" && statuses["dry-run"] !== "skipped") ||
                (phase.id === "summary" && statuses.promote !== "done" && statuses.promote !== "failed") ||
                ((statuses.summary === "done" || statuses.summary === "failed") && phase.id !== "summary")
              }
              className={cn(
                "flex flex-col items-center gap-1 px-2 py-1 rounded transition-colors min-w-[64px]",
                isSkipped ? "opacity-40 cursor-default"
                  : ((statuses.summary === "done" || statuses.summary === "failed") && phase.id !== "summary")
                  ? "opacity-40 cursor-not-allowed"
                  : (phase.id === "promote" && statuses["dry-run"] !== "done" && statuses["dry-run"] !== "skipped")
                  ? "opacity-40 cursor-not-allowed"
                  : (phase.id === "summary" && statuses.promote !== "done" && statuses.promote !== "failed")
                  ? "opacity-40 cursor-not-allowed"
                  : "hover:bg-slate-50 cursor-pointer"
              )}
            >
              <div className={dot}>
                {status === "done"    && <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                {status === "failed"  && <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>}
                {status === "skipped" && <span>—</span>}
                {(status === "pending" || status === "running") && <span>{i + 1}</span>}
              </div>
              <div className="text-center">
                <div className={cn("text-[10px] font-semibold whitespace-nowrap leading-tight", isActive ? "text-sky-700" : "text-slate-500")}>
                  {phase.label}
                </div>
                <div className="text-[9px] text-slate-400 whitespace-nowrap leading-tight">{phase.description}</div>
              </div>
            </button>
            {i < PHASE_DEFS.length - 1 && (
              <div className={cn("h-px w-4 shrink-0 mx-0.5 mt-[-16px]", status === "done" ? "bg-emerald-300" : "bg-slate-200")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Subcommand card styles (fr-config promote) ────────────────────────────────

const VARIANT_STYLES = {
  default: "border-slate-200 bg-slate-50 hover:border-slate-400 text-slate-700",
  info:    "border-blue-200 bg-blue-50 hover:border-blue-400 text-blue-800",
  warning: "border-yellow-200 bg-yellow-50 hover:border-yellow-400 text-yellow-800",
  danger:  "border-red-200 bg-red-50 hover:border-red-400 text-red-800",
};
const VARIANT_BUTTON_STYLES = {
  default: "bg-slate-700 hover:bg-slate-800 text-white",
  info:    "bg-blue-600 hover:bg-blue-700 text-white",
  warning: "bg-yellow-500 hover:bg-yellow-600 text-white",
  danger:  "bg-red-600 hover:bg-red-700 text-white",
};

// ── ESV precheck panel (runs before Dry Run) ─────────────────────────────────

function EsvPrecheckPanel({ task, visible }: { task: PromotionTask; visible: boolean }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PromotePrecheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Run once on first visibility, and whenever the task changes.
  const taskKey = `${task.id}|${task.source.environment}|${task.target.environment}|${task.items.map((i) => `${i.scope}:${(i.items ?? []).join(",")}`).join("|")}`;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    fetch("/api/promote/esv-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceEnv: task.source.environment,
        targetEnv: task.target.environment,
        scopeSelections: task.items,
      }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
        setResult(body as PromotePrecheckResult);
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, taskKey]);

  if (!visible) return null;

  const toggle = (name: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs text-slate-500 flex items-center gap-2">
        <svg className="w-3 h-3 animate-spin text-sky-600 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Running ESV precheck on {task.items.length} scope{task.items.length === 1 ? "" : "s"}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
        ESV precheck failed: {error}
      </div>
    );
  }

  if (!result) return null;

  if (result.missing.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span>
          ESV precheck passed — every referenced ESV exists on{" "}
          <span className="font-mono font-semibold">{task.target.environment}</span>
          {" "}
          ({result.totalReferencedNames} names across {result.scannedFiles} files).
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs space-y-2">
      <div className="flex items-start gap-2">
        <svg className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <div className="space-y-0.5">
          <p className="font-semibold text-amber-800">
            {result.missing.length} ESV{result.missing.length === 1 ? "" : "s"} referenced by selected items but missing on target
          </p>
          <p className="text-[11px] text-amber-700">
            <span className="font-mono">{task.source.environment}</span>
            {" "}
            →
            {" "}
            <span className="font-mono">{task.target.environment}</span>.
            {" "}
            Scanned {result.scannedFiles} file{result.scannedFiles === 1 ? "" : "s"} across {task.items.length} scope{task.items.length === 1 ? "" : "s"}. Define these on the target before promoting, or the promoted config will reference unresolved ESVs.
          </p>
        </div>
      </div>
      <div className="divide-y divide-amber-200 rounded border border-amber-200 bg-white max-h-60 overflow-y-auto">
        {result.missing.map((m) => {
          const open = expanded.has(m.name);
          return (
            <div key={m.name}>
              <button
                type="button"
                onClick={() => toggle(m.name)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-amber-50 transition-colors"
              >
                <span className="text-amber-500 text-[10px] w-3">{open ? "▾" : "▸"}</span>
                <span className="font-mono font-semibold text-amber-800 flex-1 truncate">esv-{m.name}</span>
                <span className="text-[10px] text-amber-600 tabular-nums shrink-0">{m.references.length} ref{m.references.length === 1 ? "" : "s"}</span>
              </button>
              {open && (
                <div className="bg-amber-50/40 px-3 pb-2 pt-1 space-y-0.5">
                  {m.references.slice(0, 10).map((r, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] font-mono">
                      <span className="shrink-0 text-amber-500 tabular-nums">{r.line}</span>
                      <span className="shrink-0 text-amber-700 truncate max-w-[320px]" title={r.path}>{r.path}</span>
                      <span className="flex-1 text-amber-800/80 break-all">{r.snippet}</span>
                    </div>
                  ))}
                  {m.references.length > 10 && (
                    <div className="text-[10px] text-amber-600 italic">… and {m.references.length - 10} more</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Item progress panel (Dry Run) ─────────────────────────────────────────────

type DryRunItemStatus = "pending" | "source" | "target" | "both" | "done" | "failed";

function ItemProgressPanel({
  selections,
  itemStatus,
  running,
}: {
  selections: ScopeSelection[];
  itemStatus: (scope: string) => DryRunItemStatus;
  running: boolean;
}) {
  const totalItems = selections.reduce((acc, s) => acc + (s.items?.length ?? 1), 0);
  const counts = { done: 0, running: 0, failed: 0, pending: 0 };
  for (const sel of selections) {
    const st = itemStatus(sel.scope);
    const n = sel.items?.length ?? 1;
    if (st === "done") counts.done += n;
    else if (st === "failed") counts.failed += n;
    else if (st === "pending") counts.pending += n;
    else counts.running += n;
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="px-3 py-1.5 border-b border-slate-100 bg-slate-50/60 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Items being checked
        </span>
        <span className="text-[10px] text-slate-400">
          {totalItems} total · {counts.done} done{counts.running ? ` · ${counts.running} running` : ""}{counts.failed ? ` · ${counts.failed} failed` : ""}{counts.pending ? ` · ${counts.pending} pending` : ""}
        </span>
      </div>
      <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
        {selections.map((sel) => {
          const st = itemStatus(sel.scope);
          return (
            <div key={sel.scope} className="px-3 py-2">
              <div className="flex items-center gap-2 mb-1">
                <StatusDot status={st} running={running} />
                <span className="text-xs font-semibold text-slate-700 font-mono">{sel.scope}</span>
                <StatusLabel status={st} />
                <span className="ml-auto text-[10px] text-slate-400">
                  {sel.items?.length ?? "all"} item{(sel.items?.length ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              {sel.items && sel.items.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pl-4">
                  {sel.items.map((item: string) => (
                    <span
                      key={item}
                      className={cn(
                        "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded font-mono ring-1 transition-colors",
                        st === "done"    && "bg-emerald-50 text-emerald-700 ring-emerald-200",
                        st === "failed"  && "bg-rose-50 text-rose-700 ring-rose-200",
                        st === "pending" && "bg-slate-50 text-slate-500 ring-slate-200",
                        (st === "source" || st === "target" || st === "both") && "bg-sky-50 text-sky-700 ring-sky-200"
                      )}
                    >
                      {(st === "source" || st === "target" || st === "both") && (
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                      )}
                      {item}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="pl-4 text-[10px] text-slate-400 italic">All items in scope</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusDot({ status, running }: { status: DryRunItemStatus; running: boolean }) {
  if (status === "done") return <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />;
  if (status === "failed") return <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />;
  if (status === "pending") return <span className={cn("w-2 h-2 rounded-full shrink-0", running ? "bg-slate-300" : "bg-slate-200")} />;
  return <span className="w-2 h-2 rounded-full bg-sky-500 animate-pulse shrink-0" />;
}

function StatusLabel({ status }: { status: DryRunItemStatus }) {
  const map: Record<DryRunItemStatus, { label: string; cls: string }> = {
    done:    { label: "done",                  cls: "bg-emerald-100 text-emerald-700" },
    failed:  { label: "failed",                cls: "bg-rose-100 text-rose-700" },
    pending: { label: "pending",               cls: "bg-slate-100 text-slate-500" },
    source:  { label: "pulling source",        cls: "bg-sky-100 text-sky-700" },
    target:  { label: "pulling target",        cls: "bg-sky-100 text-sky-700" },
    both:    { label: "pulling both sides",    cls: "bg-sky-100 text-sky-700" },
  };
  const { label, cls } = map[status];
  return <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", cls)}>{label}</span>;
}

// ── Phase 2: Dry Run ──────────────────────────────────────────────────────────

function DryRunPhase({
  task,
  visible,
  includeDeps,
  onIncludeDepsChange,
  hasJourneys,
  onComplete,
  onReport,
}: {
  task: PromotionTask;
  visible: boolean;
  includeDeps: boolean;
  onIncludeDepsChange: (v: boolean) => void;
  hasJourneys: boolean;
  onComplete: (s: PhaseStatus) => void;
  onReport: (r: import("@/lib/diff-types").CompareReport) => void;
}) {
  const { logs, running, exitCode, report, run, abort } = useStreamingLogs();
  const { setBusy } = useBusyState();
  const onCompleteRef = useRef(onComplete);
  const onReportRef = useRef(onReport);
  useEffect(() => { onCompleteRef.current = onComplete; });
  useEffect(() => { onReportRef.current = onReport; });
  useEffect(() => { setBusy(running); }, [running, setBusy]);

  // Cache the report for step 3's diff preview
  useEffect(() => {
    if (report) onReportRef.current(report);
  }, [report]);

  useEffect(() => {
    if (exitCode !== null && !running) onCompleteRef.current(exitCode === 0 ? "done" : "failed");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitCode, running]);

  // Use the task's item selections for item-level comparison
  const scopeSelections = task.items.filter((i) =>
    getCommandType(i.scope) === "fr-config"
  );

  const compare = () =>
    run("/api/compare", {
      source: task.source,
      target: task.target,
      scopeSelections,
      includeDeps: hasJourneys ? includeDeps : false,
      mode: "dry-run",
      diffOptions: { includeMetadata: false, ignoreWhitespace: true },
    });

  const sourceLogs = logs.filter((l) => l.side === "source");
  const targetLogs = logs.filter((l) => l.side === "target");
  const sourceExitCode = logs.find((l) => l.type === "exit" && l.side === "source")?.code ?? null;
  const targetExitCode = logs.find((l) => l.type === "exit" && l.side === "target")?.code ?? null;
  const sourceRunning = running && sourceExitCode === null;
  const targetRunning = running && targetExitCode === null;
  const showConsole = logs.length > 0 || running;

  // Derive per-scope status from scope-start / scope-end events on each side.
  const scopeProgress = useMemo(() => {
    type PerSide = { current: string | null; completed: Set<string>; errored: Set<string> };
    const build = (sideLogs: typeof logs): PerSide => {
      const completed = new Set<string>();
      const errored = new Set<string>();
      let current: string | null = null;
      for (const l of sideLogs) {
        if (l.type === "scope-start" && l.scope) current = l.scope;
        else if (l.type === "scope-end" && l.scope) {
          if (l.code === 0) completed.add(l.scope);
          else errored.add(l.scope);
          if (current === l.scope) current = null;
        }
      }
      return { current, completed, errored };
    };
    return { source: build(sourceLogs), target: build(targetLogs) };
  }, [sourceLogs, targetLogs]);

  type ItemStatus = "pending" | "source" | "target" | "both" | "done" | "failed";
  const itemStatus = (scope: string): ItemStatus => {
    const s = scopeProgress.source;
    const t = scopeProgress.target;
    if (s.errored.has(scope) || t.errored.has(scope)) return "failed";
    const sourceDone = s.completed.has(scope) || task.source.mode === "local" || sourceExitCode === 0;
    const targetDone = t.completed.has(scope) || task.target.mode === "local" || targetExitCode === 0;
    if (sourceDone && targetDone) return "done";
    const sourceRunningNow = s.current === scope;
    const targetRunningNow = t.current === scope;
    if (sourceRunningNow && targetRunningNow) return "both";
    if (sourceRunningNow) return "source";
    if (targetRunningNow) return "target";
    return "pending";
  };

  return (
    <div className={cn(!visible && "hidden")}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Simulate what will change on the target (<span className="font-mono">{task.target.environment}</span>) if the source (<span className="font-mono">{task.source.environment}</span>) is promoted to it. Review the diff carefully before proceeding.
        </p>

        <EsvPrecheckPanel
          task={task}
          visible={visible}
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={compare}
            disabled={running}
            className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            {running ? "Running…" : "Start Dry-run"}
          </button>
          {running && (
            <button onClick={abort} className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors">
              Abort
            </button>
          )}
          {hasJourneys && (
            <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeDeps}
                onChange={(e) => onIncludeDepsChange(e.target.checked)}
                disabled={running}
                className="accent-sky-600"
              />
              <span>Include Dependencies (InnerTree, Scripts…)</span>
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded", includeDeps ? "text-sky-700 bg-sky-50" : "text-slate-400 bg-slate-100")}>
                {includeDeps ? "on" : "off"}
              </span>
            </label>
          )}
        </div>

        {/* Item progress panel — shows every selected item grouped by scope,
            with live per-scope status derived from scope-start/end events. */}
        {scopeSelections.length > 0 && (
          <ItemProgressPanel
            selections={scopeSelections}
            itemStatus={itemStatus}
            running={running}
          />
        )}

        {/* Console panels */}
        {showConsole && (
          <div className="rounded-lg border border-slate-700 overflow-hidden grid grid-cols-2 divide-x divide-slate-700">
            <div className="min-w-0 flex flex-col">
              <div className="px-3 py-1.5 bg-slate-700 border-b border-slate-600">
                <span className="text-[10px] font-semibold text-slate-300 uppercase tracking-widest">Source — {task.source.environment}</span>
              </div>
              <ScopedLogViewer logs={sourceLogs} running={sourceRunning} exitCode={sourceExitCode} />
            </div>
            <div className="min-w-0 flex flex-col">
              <div className="px-3 py-1.5 bg-slate-700 border-b border-slate-600">
                <span className="text-[10px] font-semibold text-slate-300 uppercase tracking-widest">Target — {task.target.environment}</span>
              </div>
              <ScopedLogViewer logs={targetLogs} running={targetRunning} exitCode={targetExitCode} />
            </div>
          </div>
        )}

        {/* Missing dependencies warning */}
        {report && !running && report.missingDeps &&
          (report.missingDeps.missingJourneys.length > 0 || report.missingDeps.missingScripts.length > 0) && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm space-y-2">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <div className="space-y-1.5">
                <p className="font-semibold text-amber-800">
                  Missing dependencies in target ({task.target.environment})
                </p>
                <p className="text-xs text-amber-700">
                  The selected journeys reference the following dependencies that do not exist on the target.
                  Pushing without them may cause failures. Consider enabling &quot;Include Dependencies&quot; in the task.
                </p>
                {report.missingDeps.missingJourneys.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-amber-800 mt-1">Sub-journeys</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {report.missingDeps.missingJourneys.map((name) => (
                        <li key={name} className="text-xs text-amber-700 font-mono pl-3">• {name}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.missingDeps.missingScripts.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-amber-800 mt-1">Scripts</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {report.missingDeps.missingScripts.map((name) => (
                        <li key={name} className="text-xs text-amber-700 font-mono pl-3">• {name}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Diff report */}
        {report && !running && <DiffReport report={report} mode="dry-run" />}
      </div>
    </div>
  );
}

// ── Promote progress tracker ──────────────────────────────────────────────────

const PROMOTE_PHASES = [
  { scope: "resolve-deps",      label: "Resolve Deps" },
  { scope: "prepare",           label: "Prepare" },
  { scope: "remap-ids",         label: "Remap IDs" },
  { scope: "remap-script-refs", label: "Remap Scripts" },
  { scope: "push",              label: "Push" },
  { scope: "pull-target",       label: "Pull Target" },
  { scope: "verify",            label: "Verify" },
];

function PromoteProgress({ logs, running, extraPhases }: { logs: LogEntry[]; running: boolean; extraPhases?: { scope: string; status: "running" | "done" | "failed" }[] }) {
  const { phases, currentPhase, lineCountsByPhase } = useMemo(() => {
    const completed = new Set<string>();
    const errored = new Set<string>();
    const started = new Set<string>();
    const counts = new Map<string, number>();
    let active: string | null = null;
    for (const l of logs) {
      if (l.type === "scope-start" && l.scope) {
        started.add(l.scope);
        active = l.scope;
      } else if (l.type === "scope-end" && l.scope) {
        if (l.code === 0) completed.add(l.scope);
        else errored.add(l.scope);
        if (active === l.scope) active = null;
      } else if ((l.type === "stdout" || l.type === "stderr") && active) {
        counts.set(active, (counts.get(active) ?? 0) + 1);
      }
    }
    // Only show phases that have started (hide phases like resolve-deps if not triggered)
    const visible = PROMOTE_PHASES.filter(p => started.has(p.scope));
    const phaseStates = visible.map(p => ({
      ...p,
      status: errored.has(p.scope) ? "failed" as const
        : completed.has(p.scope) ? "done" as const
        : active === p.scope ? "running" as const
        : started.has(p.scope) ? "running" as const
        : "pending" as const,
    }));
    // Merge in extra phases (e.g. verify that runs outside the stream)
    if (extraPhases) {
      for (const ep of extraPhases) {
        const def = PROMOTE_PHASES.find(p => p.scope === ep.scope);
        if (def && !phaseStates.some(p => p.scope === ep.scope)) {
          phaseStates.push({ ...def, status: ep.status });
        }
      }
    }
    return { phases: phaseStates, currentPhase: active, lineCountsByPhase: counts };
  }, [logs, extraPhases]);

  if (phases.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {phases.map((p, i) => (
        <div key={p.scope} className="flex items-center gap-1">
          {i > 0 && (
            <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full ring-1 font-medium transition-colors",
              p.status === "running"
                ? "bg-indigo-600 text-white ring-indigo-600"
                : p.status === "done"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : p.status === "failed"
                    ? "bg-rose-50 text-rose-700 ring-rose-200"
                    : "bg-slate-50 text-slate-500 ring-slate-200"
            )}
          >
            {p.status === "running" && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
            {p.status === "done" && <span>✓</span>}
            {p.status === "failed" && <span>✗</span>}
            {p.label}
            {(p.status === "running" || p.status === "done" || p.status === "failed") && (lineCountsByPhase.get(p.scope) ?? 0) > 0 && (
              <span className={cn(
                "text-[9px] tabular-nums",
                p.status === "running" ? "text-indigo-200" : p.status === "done" ? "text-emerald-500" : "text-rose-500"
              )}>
                {lineCountsByPhase.get(p.scope)}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Phase 3: Promote (item-level push with ID remapping) ─────────────────────

function FrConfigSection({
  task,
  targetIsControlled,
  includeDeps,
  isProdTarget,
  dryRunReport,
  onComplete,
  onTaskStatusChange,
  onVerifyReport,
  onLogsChange,
}: {
  task: PromotionTask;
  targetIsControlled?: boolean;
  includeDeps: boolean;
  isProdTarget: boolean;
  dryRunReport: import("@/lib/diff-types").CompareReport | null;
  onComplete: (s: PhaseStatus) => void;
  onTaskStatusChange: (s: TaskStatus) => void;
  onVerifyReport: (r: import("@/lib/diff-types").CompareReport) => void;
  onLogsChange: (logs: LogEntry[]) => void;
}) {
  const { logs, running, exitCode, run, abort, clear } = useStreamingLogs();
  const { setBusy } = useBusyState();
  const onLogsChangeRef = useRef(onLogsChange);
  useEffect(() => { onLogsChangeRef.current = onLogsChange; });
  useEffect(() => { onLogsChangeRef.current(logs); }, [logs]);
  const [promoteConfirmOpen, setPromoteConfirmOpen] = useState(false);
  const [verifyRunning, setVerifyRunning] = useState(false);
  const [verifyDone, setVerifyDone] = useState(false);
  // Tracked DCC session state while promoting to a controlled env. Used to
  // gate the Abort button — abort is only meaningful while a session exists
  // and has not yet started applying.
  const [dccState, setDccState] = useState<string | null>(null);
  const [dccBusy, setDccBusy] = useState(false);
  const abortRequestedRef = useRef(false);

  // Synthetic log entries for DCC transitions. Merged with the streaming
  // push logs so the user sees one unified timeline in the existing log viewer.
  // ScopedLogViewer only renders entries that fall inside a scope-start /
  // scope-end pair, so wrap each DCC phase (open / apply / verify-pull /
  // abort) with dccScopeStart + dccScopeEnd — otherwise the lines are
  // silently dropped from the viewer.
  const [dccLogs, setDccLogs] = useState<LogEntry[]>([]);
  const pushDccLog = (data: string, type: "stdout" | "stderr" = "stdout") => {
    setDccLogs((prev) => [...prev, { type, data: `[dcc] ${data}\n`, ts: Date.now() }]);
  };
  const dccScopeStart = (scope: string) => {
    setDccLogs((prev) => [...prev, { type: "scope-start", scope, ts: Date.now() }]);
  };
  const dccScopeEnd = (scope: string, code: number) => {
    setDccLogs((prev) => [...prev, { type: "scope-end", scope, code, ts: Date.now() }]);
  };
  const onCompleteRef = useRef(onComplete);
  const onTaskStatusRef = useRef(onTaskStatusChange);
  const onVerifyReportRef = useRef(onVerifyReport);
  useEffect(() => { onCompleteRef.current = onComplete; });
  useEffect(() => { onTaskStatusRef.current = onTaskStatusChange; });
  useEffect(() => { onVerifyReportRef.current = onVerifyReport; });
  useEffect(() => { setBusy(running || verifyRunning); }, [running, verifyRunning, setBusy]);

  // Run verify compare (source vs freshly-pulled target) and resolve the
  // final task status based on whether the report has any non-unchanged files.
  const runVerify = useCallback(async () => {
    setVerifyRunning(true);
    const scopeSelections = task.items.filter((i) => getCommandType(i.scope) === "fr-config");
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { ...task.target, mode: "local" },
          target: { ...task.source, mode: "local" },
          scopeSelections,
          includeDeps: task.includeDeps ?? false,
          mode: "compare",
          diffOptions: { includeMetadata: false, ignoreWhitespace: true },
        }),
      });
      if (!res.ok) throw new Error(`verify compare returned ${res.status}`);
      const text = await res.text();
      let report: import("@/lib/diff-types").CompareReport | null = null;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { type: string; data?: string };
          if (entry.type === "report" && entry.data) {
            report = JSON.parse(entry.data) as import("@/lib/diff-types").CompareReport;
            break;
          }
        } catch { /* skip */ }
      }
      if (report) {
        onVerifyReportRef.current(report);
        const diffCount = report.files.filter((f) => f.status !== "unchanged").length;
        if (diffCount > 0) {
          // Target does not match source after promote — treat as failure.
          onCompleteRef.current("failed");
          onTaskStatusRef.current("failed");
        } else {
          onCompleteRef.current("done");
          onTaskStatusRef.current("completed");
        }
      } else {
        onCompleteRef.current("done");
        onTaskStatusRef.current("completed");
      }
    } catch {
      onCompleteRef.current("done"); // verify failure is non-fatal for overall status
      onTaskStatusRef.current("completed");
    } finally {
      setVerifyRunning(false);
      setVerifyDone(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  // Auto-run verify after a non-controlled promote finishes.
  // Controlled promotes run verify separately after SESSION_APPLIED + pull-target.
  useEffect(() => {
    if (targetIsControlled) return;
    if (exitCode === null || running) return;
    if (exitCode !== 0) {
      onCompleteRef.current("failed");
      onTaskStatusRef.current("failed");
      return;
    }
    runVerify();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitCode, running, targetIsControlled]);

  const frConfigItems = task.items.filter((i) => getCommandType(i.scope) === "fr-config");
  const hasJourneys = task.items.some((i) => i.scope === "journeys");

  // DCC helper — calls /api/dcc endpoint for controlled environments
  const callDcc = async (subcommand: string, dccArgs: string[] = []): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
    const res = await fetch("/api/dcc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: task.target.environment, subcommand, args: dccArgs }),
    });
    return res.json();
  };

  // Abort states that allow a meaningful rollback. Apply/Applied states are
  // excluded — at that point the session is being or has been committed.
  const ABORTABLE_DCC_STATES = new Set([
    "SESSION_INITIALISE_REQUESTED",
    "SESSION_INITIALISING",
    "SESSION_INITIALISED",
  ]);

  const canAbort = targetIsControlled
    ? running || dccBusy || (dccState !== null && ABORTABLE_DCC_STATES.has(dccState))
    : running;

  const handleAbort = async () => {
    abortRequestedRef.current = true;
    if (targetIsControlled) {
      dccScopeStart("abort-session");
      pushDccLog("User aborted — calling direct-control-abort.", "stderr");
      try { await callDcc("direct-control-abort"); } catch { /* best-effort */ }
      setDccState("SESSION_ABORT_REQUESTED");
      setDccBusy(false);
      dccScopeEnd("abort-session", 0);
    }
    abort();
  };

  // Merge DCC synthetic logs with streaming push logs into a unified timeline.
  const mergedLogs = useMemo(
    () => [...dccLogs, ...logs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)),
    [dccLogs, logs],
  );

  const diffLoader = useCallback(async () => {
    if (!dryRunReport) throw new Error("Run the dry-run first to generate a diff preview");
    const { summarizeReport } = await import("@/lib/compare");
    return summarizeReport(dryRunReport);
  }, [dryRunReport]);

  const runActualPromote = async () => {
    if (task.status === "new") onTaskStatusChange("in-progress");

    if (targetIsControlled) {
      setDccLogs([]);
      abortRequestedRef.current = false;
      setDccBusy(true);
      dccScopeStart("open-session");
      pushDccLog("Checking direct-control session state…");
      // DCC Step 1: Check state
      const stateRes = await callDcc("direct-control-state");
      let stateJson: { status?: string } = {};
      try { stateJson = JSON.parse(stateRes.stdout.trim()); } catch { /* ignore */ }
      setDccState(stateJson.status ?? null);
      pushDccLog(`State: ${stateJson.status ?? "unknown"}`);

      if (stateJson.status && stateJson.status !== "NO_SESSION" && stateJson.status !== "SESSION_APPLIED") {
        // Session already active — skip init, go straight to push
        pushDccLog("Session already active — skipping init.");
      } else {
        // DCC Step 2: Init session
        pushDccLog("Initialising direct-control session…");
        const initRes = await callDcc("direct-control-init");
        if (initRes.exitCode !== 0) {
          pushDccLog(`Init failed: ${initRes.stderr || initRes.stdout}`, "stderr");
          dccScopeEnd("open-session", 1);
          setDccBusy(false);
          onTaskStatusChange("failed");
          return;
        }
        setDccState("SESSION_INITIALISE_REQUESTED");
        pushDccLog("Init requested. Waiting for SESSION_INITIALISED…");

        // Poll until SESSION_INITIALISED. Session provisioning on a cold
        // controlled tenant takes ~130s in the field, so keep a generous
        // budget to avoid spurious aborts.
        const pollStart = Date.now();
        let reached = false;
        let lastLoggedStatus = "";
        while (Date.now() - pollStart < 240_000) {
          await new Promise((r) => setTimeout(r, 5000));
          if (abortRequestedRef.current) { dccScopeEnd("open-session", 1); setDccBusy(false); return; }
          const pollRes = await callDcc("direct-control-state");
          let pollState: { status?: string } = {};
          try { pollState = JSON.parse(pollRes.stdout.trim()); } catch { /* ignore */ }
          if (pollState.status) setDccState(pollState.status);
          if (pollState.status && pollState.status !== lastLoggedStatus) {
            const elapsed = Math.round((Date.now() - pollStart) / 1000);
            pushDccLog(`${pollState.status} (${elapsed}s)`);
            lastLoggedStatus = pollState.status;
          }
          if (pollState.status === "SESSION_INITIALISED") { reached = true; break; }
          if (pollState.status === "ERROR") {
            pushDccLog("Session entered ERROR state — aborting.", "stderr");
            await callDcc("direct-control-abort");
            dccScopeEnd("open-session", 1);
            setDccBusy(false);
            onTaskStatusChange("failed");
            return;
          }
        }
        if (!reached) {
          pushDccLog("Timed out waiting for SESSION_INITIALISED — aborting.", "stderr");
          await callDcc("direct-control-abort");
          dccScopeEnd("open-session", 1);
          setDccBusy(false);
          onTaskStatusChange("failed");
          return;
        }
      }
      pushDccLog("Session ready. Starting push with --direct-control…");
      dccScopeEnd("open-session", 0);
      setDccBusy(false);
    }

    // DCC Step 3 (or normal): Push with directControl flag
    run("/api/promote-items", {
      sourceEnvironment: task.source.environment,
      targetEnvironment: task.target.environment,
      includeDeps: hasJourneys ? includeDeps : false,
      scopeSelections: frConfigItems,
      directControl: targetIsControlled,
    });
  };

  // DCC Step 4: Apply after push completes. Non-blocking `apply`, then poll
  // state every 5s and log each transition until SESSION_APPLIED.
  useEffect(() => {
    if (!targetIsControlled || exitCode === null || running) return;
    if (abortRequestedRef.current) return; // user already aborted

    (async () => {
      if (exitCode !== 0) {
        dccScopeStart("abort-session");
        pushDccLog(`Push failed (exit ${exitCode}) — aborting session.`, "stderr");
        setDccState("SESSION_ABORT_REQUESTED");
        await callDcc("direct-control-abort");
        dccScopeEnd("abort-session", 0);
        return;
      }

      dccScopeStart("apply-session");
      pushDccLog("Push complete. Applying session…");
      setDccState("SESSION_APPLYING");
      setDccBusy(true);
      const applyRes = await callDcc("direct-control-apply");
      if (applyRes.exitCode !== 0) {
        pushDccLog(`Apply request failed: ${applyRes.stderr || applyRes.stdout}`, "stderr");
        setDccState("SESSION_ABORT_REQUESTED");
        await callDcc("direct-control-abort");
        dccScopeEnd("apply-session", 1);
        setDccBusy(false);
        return;
      }

      // Poll until SESSION_APPLIED (or error). Apply typically takes 2-3 min
      // on temp-dcc; allow up to 6 min for safety.
      const pollStart = Date.now();
      let lastLoggedStatus = "";
      let applied = false;
      while (Date.now() - pollStart < 360_000) {
        await new Promise((r) => setTimeout(r, 5000));
        if (abortRequestedRef.current) break;
        const pollRes = await callDcc("direct-control-state");
        let pollState: { status?: string } = {};
        try { pollState = JSON.parse(pollRes.stdout.trim()); } catch { /* ignore */ }
        if (pollState.status) setDccState(pollState.status);
        if (pollState.status && pollState.status !== lastLoggedStatus) {
          const elapsed = Math.round((Date.now() - pollStart) / 1000);
          pushDccLog(`${pollState.status} (${elapsed}s)`);
          lastLoggedStatus = pollState.status;
        }
        if (pollState.status === "SESSION_APPLIED") { applied = true; break; }
        if (pollState.status === "ERROR") {
          pushDccLog("Session entered ERROR state during apply — aborting.", "stderr");
          await callDcc("direct-control-abort");
          dccScopeEnd("apply-session", 1);
          setDccBusy(false);
          return;
        }
      }
      if (!applied) {
        pushDccLog("Timed out waiting for SESSION_APPLIED.", "stderr");
        dccScopeEnd("apply-session", 1);
        setDccBusy(false);
        onCompleteRef.current("failed");
        onTaskStatusRef.current("failed");
        return;
      }
      pushDccLog("Session applied successfully.");
      dccScopeEnd("apply-session", 0);

      // Pull target now that the tenant holds the committed changes, then verify.
      dccScopeStart("verify-pull");
      pushDccLog("Pulling target to sync local files for verify…");
      const pullScopes = Array.from(new Set(task.items.map((i) => i.scope)));
      let pullSucceeded = true;
      try {
        const pullRes = await fetch("/api/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environment: task.target.environment, scopes: pullScopes }),
        });
        if (!pullRes.ok || !pullRes.body) throw new Error(`pull returned ${pullRes.status}`);
        const reader = pullRes.body.pipeThrough(new TextDecoderStream()).getReader();
        let pullExit = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of value.split("\n")) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line) as { type?: string; code?: number };
              if (p.type === "exit" && typeof p.code === "number") pullExit = p.code;
            } catch { /* ignore */ }
          }
        }
        if (pullExit !== 0) {
          pushDccLog(`Pull-target exited with code ${pullExit}.`, "stderr");
          pullSucceeded = false;
        } else {
          pushDccLog("Pull-target completed.");
        }
      } catch (err) {
        pushDccLog(`Pull-target failed: ${err instanceof Error ? err.message : String(err)}`, "stderr");
        pullSucceeded = false;
      } finally {
        dccScopeEnd("verify-pull", pullSucceeded ? 0 : 1);
        setDccBusy(false);
      }
      await runVerify();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitCode, running]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Push selected items from <span className="font-medium text-slate-700">{task.source.environment}</span> to <span className="font-medium text-slate-700">{task.target.environment}</span> with automatic ID remapping.
        After push, target is automatically pulled to sync local files for verification.
      </p>

      {targetIsControlled && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
          <span>Controlled environment — changes will go through Direct Config Control (init &rarr; push via /mutable &rarr; apply).</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {frConfigItems.map(({ scope, items }) => (
          <span key={scope} className="px-2 py-0.5 rounded border border-slate-200 bg-white text-slate-600">
            {scopeLabel(scope)}
            {items && <span className="text-slate-400 ml-1">×{items.length}</span>}
          </span>
        ))}
      </div>

      {hasJourneys && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span>Include Dependencies:</span>
          <span className={cn("px-1.5 py-0.5 rounded font-medium", includeDeps ? "text-sky-700 bg-sky-50" : "text-slate-500 bg-slate-100")}>
            {includeDeps ? "on" : "off"}
          </span>
          <span className="text-slate-400">— set in Step 2 Dry Run.</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => setPromoteConfirmOpen(true)}
          disabled={running || dccBusy || frConfigItems.length === 0}
          className="px-4 py-1.5 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          {running || dccBusy ? "Promoting…" : "Promote Selected Items"}
        </button>
        {canAbort && (
          <button
            onClick={handleAbort}
            title={targetIsControlled ? `Abort controlled session${dccState ? ` (state: ${dccState})` : ""}` : "Abort"}
            className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors"
          >
            Abort
          </button>
        )}
      </div>

      {(running || dccBusy || mergedLogs.length > 0) && (
        <div className="space-y-2">
          {targetIsControlled && dccState && (
            <div className="px-3 py-1.5 rounded bg-slate-50 border border-slate-200 text-[11px] text-slate-600 font-mono">
              DCC session: <span className="text-slate-800">{dccState}</span>
              {dccBusy && <span className="ml-2 text-sky-600 animate-pulse">●</span>}
            </div>
          )}
          <PromoteProgress
            logs={mergedLogs}
            running={running || dccBusy}
            extraPhases={verifyRunning ? [{ scope: "verify", status: "running" }] : verifyDone ? [{ scope: "verify", status: "done" }] : undefined}
          />
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <ScopedLogViewer logs={mergedLogs} running={running || dccBusy} exitCode={exitCode} onClear={() => { clear(); setDccLogs([]); }} />
          </div>
        </div>
      )}

      <DangerousConfirmDialog
        open={promoteConfirmOpen}
        title={`Promote → ${task.target.environment}`}
        subtitle={
          isProdTarget
            ? "This writes config to a live production tenant. Review the diff preview below before confirming."
            : "This writes config to the target tenant. Review the diff preview below before confirming."
        }
        tenantName={task.target.environment}
        requireTypeToConfirm={isProdTarget}
        blockUntilDiffLoaded={isProdTarget}
        diffLoader={diffLoader}
        onConfirm={() => { setPromoteConfirmOpen(false); void runActualPromote(); }}
        onCancel={() => setPromoteConfirmOpen(false)}
      />
    </div>
  );
}

function FrodoSection({
  task,
  frodoScopes,
  onComplete,
}: {
  task: PromotionTask;
  frodoScopes: string[];
  onComplete: (s: PhaseStatus) => void;
}) {
  const { logs, running, exitCode, run, abort, clear } = useStreamingLogs();
  const { setBusy } = useBusyState();
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });
  useEffect(() => { setBusy(running); }, [running, setBusy]);
  useEffect(() => {
    if (exitCode !== null && !running) onCompleteRef.current(exitCode === 0 ? "done" : "failed");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitCode, running]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Push Frodo-managed scopes to target <span className="font-medium text-slate-700">{task.target.environment}</span> using the frodo CLI.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {frodoScopes.map((s) => (
          <span key={s} className="px-2 py-0.5 rounded text-[11px] bg-purple-50 text-purple-700 border border-purple-200 font-mono">
            {scopeLabel(s)}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => run("/api/push", { environment: task.target.environment, scopes: frodoScopes })}
          disabled={running}
          className="px-3 py-1.5 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          {running ? "Pushing…" : "Push Frodo Scopes"}
        </button>
        {running && (
          <button onClick={abort} className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors">Abort</button>
        )}
      </div>
      {(running || logs.length > 0) && (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <LogViewer logs={logs} running={running} exitCode={exitCode} onClear={clear} />
        </div>
      )}
    </div>
  );
}

function IgaSection({
  task,
  igaScopes,
  onComplete,
}: {
  task: PromotionTask;
  igaScopes: string[];
  onComplete: (s: PhaseStatus) => void;
}) {
  const { logs, running, exitCode, run, abort, clear } = useStreamingLogs();
  const { setBusy } = useBusyState();
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });
  useEffect(() => { setBusy(running); }, [running, setBusy]);
  useEffect(() => {
    if (exitCode !== null && !running) onCompleteRef.current(exitCode === 0 ? "done" : "failed");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitCode, running]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Push IGA API scopes to target <span className="font-medium text-slate-700">{task.target.environment}</span> via the IGA REST API.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {igaScopes.map((s) => (
          <span key={s} className="px-2 py-0.5 rounded text-[11px] bg-teal-50 text-teal-700 border border-teal-200 font-mono">
            {scopeLabel(s)}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => run("/api/push", { environment: task.target.environment, scopes: igaScopes })}
          disabled={running}
          className="px-3 py-1.5 text-xs font-medium rounded bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 transition-colors"
        >
          {running ? "Pushing…" : "Push IGA Scopes"}
        </button>
        {running && (
          <button onClick={abort} className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors">Abort</button>
        )}
      </div>
      {(running || logs.length > 0) && (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <LogViewer logs={logs} running={running} exitCode={exitCode} onClear={clear} />
        </div>
      )}
    </div>
  );
}

function PromotePhase({
  task,
  frConfigScopes,
  frodoScopes,
  igaScopes,
  targetIsControlled,
  isProdTarget,
  visible,
  includeDeps,
  dryRunReport,
  onVerifyReport,
  onPromoteLogs,
  onComplete,
  onTaskStatusChange,
}: {
  task: PromotionTask;
  frConfigScopes: ConfigScope[];
  frodoScopes: string[];
  igaScopes: string[];
  targetIsControlled?: boolean;
  isProdTarget: boolean;
  visible: boolean;
  includeDeps: boolean;
  dryRunReport: import("@/lib/diff-types").CompareReport | null;
  onVerifyReport: (r: import("@/lib/diff-types").CompareReport) => void;
  onPromoteLogs: (logs: LogEntry[]) => void;
  onComplete: (s: PhaseStatus) => void;
  onTaskStatusChange: (s: TaskStatus) => void;
}) {
  const sections = [
    frConfigScopes.length > 0 && "fr-config",
    frodoScopes.length > 0    && "frodo",
    igaScopes.length > 0      && "iga",
  ].filter(Boolean) as string[];

  const showSectionHeaders = sections.length > 1;

  const sectionHeader = (label: string, color: string) =>
    showSectionHeaders ? (
      <div className={cn("text-[10px] font-semibold uppercase tracking-widest mb-2", color)}>
        {label}
      </div>
    ) : null;

  return (
    <div className={cn(!visible && "hidden")}>
      <div className="space-y-6">
        {frConfigScopes.length > 0 && (
          <div>
            {sectionHeader("fr-config Promote", "text-slate-500")}
            <FrConfigSection
              task={task}
              targetIsControlled={targetIsControlled}
              includeDeps={includeDeps}
              isProdTarget={isProdTarget}
              dryRunReport={dryRunReport}
              onComplete={onComplete}
              onTaskStatusChange={onTaskStatusChange}
              onVerifyReport={onVerifyReport}
              onLogsChange={onPromoteLogs}
            />
          </div>
        )}
        {frodoScopes.length > 0 && (
          <div>
            {sectionHeader("Frodo Agents", "text-purple-500")}
            <FrodoSection
              task={task}
              frodoScopes={frodoScopes}
              onComplete={onComplete}
            />
          </div>
        )}
        {igaScopes.length > 0 && (
          <div>
            {sectionHeader("IGA API", "text-teal-600")}
            <IgaSection
              task={task}
              igaScopes={igaScopes}
              onComplete={onComplete}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Phase 4: Summary ──────────────────────────────────────────────────────────

function FullLog({ logs }: { logs: { type: string; data?: string }[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const text = logs.map((l) => l.data ?? "").join("");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="label-xs flex items-center gap-1 hover:text-slate-700 transition-colors"
        >
          <svg className={cn("w-3 h-3 transition-transform", open && "rotate-90")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          FULL LOG ({logs.length} line{logs.length === 1 ? "" : "s"})
        </button>
        {open && (
          <button
            type="button"
            onClick={handleCopy}
            className="text-[11px] text-slate-500 hover:text-slate-800 transition-colors"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {open && (
        <div className="bg-slate-900 rounded-lg overflow-auto max-h-96 p-3 font-mono text-[11px] leading-5">
          {logs.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all",
                l.type === "stderr" || l.type === "error" ? "text-red-400" : "text-slate-300",
              )}
            >
              {l.data}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorLogs({ logs }: { logs: { type: string; data?: string }[] }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const text = logs.map((l) => l.data ?? "").join("");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="label-xs">ERROR LOGS</div>
        <button
          type="button"
          onClick={handleCopy}
          className="text-[11px] text-slate-500 hover:text-slate-800 transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="bg-slate-900 rounded-lg overflow-auto max-h-64 p-3 font-mono text-[11px] leading-5">
        {logs.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-all text-red-400">{l.data}</div>
        ))}
      </div>
    </div>
  );
}

function SummaryPhase({
  task,
  visible,
  dryRunReport,
  verifyReport,
  promoteLogs,
  phaseStatuses,
  onArchive,
  onRestart,
}: {
  task: PromotionTask;
  visible: boolean;
  dryRunReport: import("@/lib/diff-types").CompareReport | null;
  verifyReport: import("@/lib/diff-types").CompareReport | null;
  promoteLogs: LogEntry[];
  phaseStatuses: Record<PhaseId, PhaseStatus>;
  onArchive: () => void;
  onRestart: () => void;
}) {
  const promoteStatus = phaseStatuses.promote;
  const succeeded = promoteStatus === "done";
  const failed = promoteStatus === "failed";

  const verifyChanges = verifyReport
    ? verifyReport.summary.added + verifyReport.summary.modified + verifyReport.summary.removed
    : null;
  const failedDueToVerify = failed && (verifyChanges ?? 0) > 0;

  // Group failing files by scope for a concise bullet list in the summary.
  const failingByScope: { scope: string; paths: string[] }[] = [];
  if (verifyReport && failedDueToVerify) {
    const groups = new Map<string, string[]>();
    for (const f of verifyReport.files) {
      if (f.status === "unchanged") continue;
      const m = f.relativePath.match(/\/([a-z0-9-]+)\//i);
      const scope = m?.[1] ?? "other";
      if (!groups.has(scope)) groups.set(scope, []);
      groups.get(scope)!.push(f.relativePath);
    }
    for (const [scope, paths] of groups.entries()) failingByScope.push({ scope, paths });
  }

  return (
    <div className={cn(!visible && "hidden")}>
      <div className="space-y-4">
        {/* Status banner */}
        <div className={cn(
          "rounded-lg border px-4 py-3 flex items-center gap-3",
          succeeded ? "border-emerald-200 bg-emerald-50" : failed ? "border-red-200 bg-red-50" : "border-slate-200 bg-slate-50"
        )}>
          {succeeded ? (
            <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          ) : failed ? (
            <svg className="w-5 h-5 text-red-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-slate-400 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
            </svg>
          )}
          <div className="flex-1">
            <p className={cn("text-sm font-semibold", succeeded ? "text-emerald-800" : failed ? "text-red-800" : "text-slate-600")}>
              {succeeded
                ? "Promotion completed successfully"
                : failedDueToVerify
                  ? "Promotion completed with errors"
                  : failed
                    ? "Promotion failed"
                    : "Promotion in progress…"}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {task.source.environment} → {task.target.environment} · {task.name}
              {failedDueToVerify && ` · ${verifyChanges} item${verifyChanges === 1 ? "" : "s"} did not match source after promote`}
            </p>
          </div>
        </div>

        {/* Failing items list when verify rejected the promote */}
        {failedDueToVerify && failingByScope.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <div className="text-[11px] font-semibold text-red-700 mb-1 uppercase tracking-wide">
              Items with differences
            </div>
            <ul className="space-y-1">
              {failingByScope.map(({ scope, paths }) => (
                <li key={scope} className="text-[11px]">
                  <span className="font-semibold text-red-700">{scope}</span>{" "}
                  <span className="text-red-500">({paths.length})</span>
                  <div className="ml-3 mt-0.5 space-y-0.5 font-mono text-red-600">
                    {paths.slice(0, 10).map((p) => (
                      <div key={p} className="truncate" title={p}>{p}</div>
                    ))}
                    {paths.length > 10 && <div className="text-red-400">…and {paths.length - 10} more</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Error + full logs — rendered for both succeeded and failed runs */}
        {(() => {
          const liveAll = promoteLogs.filter(
            (l) => l.type === "stdout" || l.type === "stderr" || l.type === "error",
          );
          const allLogs = liveAll.length > 0 ? liveAll : (task.promoteLogs ?? []);
          const errorLogs = allLogs.length > 0
            ? allLogs.filter((l) => l.type === "stderr" || l.type === "error")
            : (task.errorLogs ?? []);
          if (errorLogs.length === 0 && allLogs.length === 0) return null;
          return (
            <>
              {errorLogs.length > 0 && <ErrorLogs logs={errorLogs} />}
              {allLogs.length > 0 && <FullLog logs={allLogs} />}
            </>
          );
        })()}

        {/* Restart button for failed tasks */}
        {failed && (
          <button
            type="button"
            onClick={onRestart}
            className="px-4 py-1.5 text-xs font-medium rounded bg-sky-600 text-white hover:bg-sky-700 transition-colors"
          >
            Restart Task
          </button>
        )}

        {/* Items promoted */}
        {task.items.length > 0 && (
          <div>
            <div className="label-xs mb-2">ITEMS PROMOTED</div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {task.items.map(({ scope, items }) => (
                <span key={scope} className="px-2 py-0.5 rounded border border-slate-200 bg-white text-slate-600">
                  {scopeLabel(scope)}
                  {items && <span className="text-slate-400 ml-1">×{items.length}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Verify result */}
        {verifyReport && (
          <div>
            <div className="label-xs mb-2">
              VERIFY — {verifyChanges === 0
                ? <span className="text-emerald-600">No remaining differences</span>
                : <span className="text-amber-600">{verifyChanges} difference{verifyChanges !== 1 ? "s" : ""} found</span>
              }
            </div>
            {verifyChanges !== 0 && (
              <DiffReport report={verifyReport} mode="compare" showUnchangedByDefault />
            )}
          </div>
        )}

        {/* Dry-run report */}
        {dryRunReport && (
          <details className="group">
            <summary className="label-xs cursor-pointer select-none">
              DRY-RUN DIFF REPORT <span className="text-slate-400 group-open:hidden">▸</span><span className="text-slate-400 hidden group-open:inline">▾</span>
            </summary>
            <div className="mt-2">
              <DiffReport report={dryRunReport} mode="dry-run" />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function PromoteExecution({
  task,
  environments,
  onTaskStatusChange,
  onArchive,
}: {
  task: PromotionTask;
  environments: Environment[];
  onTaskStatusChange: (status: TaskStatus) => void;
  onArchive: () => void;
}) {
  const { confirm } = useDialog();
  const { setDirty } = useBusyState();

  // Clear dirty flag on unmount
  useEffect(() => () => setDirty(false), [setDirty]);
  const frConfigScopes = useMemo(
    () => task.items.filter((i) => getCommandType(i.scope) === "fr-config").map((i) => i.scope as ConfigScope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.items]
  );
  const frodoScopes = useMemo(
    () => task.items.filter((i) => getCommandType(i.scope) === "frodo").map((i) => i.scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.items]
  );
  const igaScopes = useMemo(
    () => task.items.filter((i) => getCommandType(i.scope) === "iga-api").map((i) => i.scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.items]
  );

  // If the task is already completed/failed (e.g. coming back from another tab),
  // initialize directly to the summary phase.
  const taskDone = task.status === "completed" || task.status === "failed";

  const [phaseStatuses, setPhaseStatuses] = useState<Record<PhaseId, PhaseStatus>>(() => ({
    "dry-run": taskDone ? "done" : frConfigScopes.length > 0 ? "pending" : "skipped",
    promote:   taskDone ? (task.status === "completed" ? "done" : "failed") : "pending",
    summary:   taskDone ? (task.status === "completed" ? "done" : "failed") : "pending",
  }));

  const [activePhase, setActivePhase] = useState<PhaseId>(taskDone ? "summary" : "dry-run");

  // Shared "include dependencies" toggle for dry-run + promote. Initialized
  // from the task's saved preference; toggling it in the Dry Run phase affects
  // both the compare call and the subsequent promote call, so the user can
  // preview the effect and carry it through without going back to edit the task.
  const [includeDeps, setIncludeDeps] = useState<boolean>(task.includeDeps ?? false);
  const [dryRunReport, setDryRunReport] = useState<import("@/lib/diff-types").CompareReport | null>(null);
  const [verifyReport, setVerifyReport] = useState<import("@/lib/diff-types").CompareReport | null>(null);
  const [promoteLogs, setPromoteLogs] = useState<LogEntry[]>([]);
  const [restartKey, setRestartKey] = useState(0);
  useEffect(() => { setIncludeDeps(task.includeDeps ?? false); }, [task.id, task.includeDeps]);
  const hasJourneys = task.items.some((i) => i.scope === "journeys");

  // Sync dry-run skipped ↔ pending when scope counts change
  useEffect(() => {
    setPhaseStatuses((prev) => {
      const next = { ...prev };
      const hasFrConfig = frConfigScopes.length > 0;
      if (!hasFrConfig && next["dry-run"] !== "skipped") next["dry-run"] = "skipped";
      if (hasFrConfig  && next["dry-run"] === "skipped") next["dry-run"] = "pending";
      return next;
    });
  }, [frConfigScopes.length]);

  // Track run start time and whether history has been emitted for this run,
  // so a re-run starts a fresh record.
  const runStartedAtRef = useRef<{ iso: string; ms: number } | null>(null);
  const historyEmittedRef = useRef(false);

  // Per-phase timings — captured on every status transition so the history
  // record can show what each phase actually took.
  type PhaseTimingClient = {
    status: PhaseStatus;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    _startMs?: number;
  };
  const phaseTimingsRef = useRef<Record<PhaseId, PhaseTimingClient>>({
    "dry-run": { status: "pending" },
    promote:   { status: "pending" },
    summary:   { status: "pending" },
  });

  const updatePhase = (id: PhaseId, status: PhaseStatus) => {
    // Mark as dirty once any phase starts — user has progress to lose
    if (status === "done" || status === "running") setDirty(true);

    setPhaseStatuses((prev) => {
      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const nowMs = nowDate.getTime();

      // On first transition into "running" for any phase, stamp the run start.
      if (status === "running" && !runStartedAtRef.current) {
        runStartedAtRef.current = { iso: nowIso, ms: nowMs };
      }
      // If the user re-runs after a previous emission (promote phase cycles
      // back to running), reset the emitted flag and reset all timings.
      if (id === "promote" && status === "running" && historyEmittedRef.current) {
        historyEmittedRef.current = false;
        runStartedAtRef.current = { iso: nowIso, ms: nowMs };
        phaseTimingsRef.current = {
          "dry-run": { status: "pending" },
          promote:   { status: "pending" },
          summary:   { status: "pending" },
        };
      }

      // Record this phase's timing transition.
      const timing = { ...(phaseTimingsRef.current[id] ?? { status: "pending" }) };
      timing.status = status;
      if (status === "running") {
        timing.startedAt = nowIso;
        timing._startMs = nowMs;
        timing.completedAt = undefined;
        timing.durationMs = undefined;
      } else if (status === "done" || status === "failed") {
        timing.completedAt = nowIso;
        if (timing._startMs != null) timing.durationMs = nowMs - timing._startMs;
      }
      phaseTimingsRef.current = { ...phaseTimingsRef.current, [id]: timing };

      return { ...prev, [id]: status };
    });
  };

  // Emit a history record when the promote phase reaches a terminal state.
  useEffect(() => {
    const promoteStatus = phaseStatuses.promote;
    if (promoteStatus !== "done" && promoteStatus !== "failed") return;
    if (historyEmittedRef.current) return;
    historyEmittedRef.current = true;

    const started = runStartedAtRef.current ?? { iso: new Date().toISOString(), ms: Date.now() };
    const completedMs = Date.now();
    const completedAt = new Date(completedMs).toISOString();

    const phaseOutcomes: Record<string, PhaseStatus> = {
      "dry-run": phaseStatuses["dry-run"],
      promote:   phaseStatuses.promote,
      summary:   phaseStatuses.summary,
    };

    // Strip _startMs (internal-only) before serializing.
    const phaseTimings: Record<string, { status: string; startedAt?: string; completedAt?: string; durationMs?: number }> = {};
    for (const [pid, t] of Object.entries(phaseTimingsRef.current)) {
      phaseTimings[pid] = {
        status: t.status,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        durationMs: t.durationMs,
      };
    }

    const scopeNames = task.items.map((i) => i.scope);
    const itemsList = task.items.map((sel) => ({ scope: sel.scope, items: sel.items }));

    // Derive diff totals from the cached dry-run report (if we have one).
    let diffTotals: { added: number; modified: number; removed: number; perScope?: Record<string, { added: number; modified: number; removed: number }> } | undefined;
    if (dryRunReport) {
      const perScope: Record<string, { added: number; modified: number; removed: number }> = {};
      for (const f of dryRunReport.files) {
        if (f.status === "unchanged") continue;
        const scope = f.scope ?? "(unknown)";
        const entry = perScope[scope] ?? { added: 0, modified: 0, removed: 0 };
        if (f.status === "added") entry.added += 1;
        else if (f.status === "modified") entry.modified += 1;
        else if (f.status === "removed") entry.removed += 1;
        perScope[scope] = entry;
      }
      diffTotals = {
        added: dryRunReport.summary.added,
        modified: dryRunReport.summary.modified,
        removed: dryRunReport.summary.removed,
        perScope,
      };
    }

    const itemCount = task.items.reduce((acc, sel) => acc + (sel.items?.length ?? 0), 0);
    const summaryBase = `${promoteStatus === "done" ? "Promoted" : "Promote failed"}: ${task.name}`;
    const summaryDetail = diffTotals
      ? ` — ${itemCount || "all"} item${itemCount === 1 ? "" : "s"} across ${scopeNames.length} scope${scopeNames.length === 1 ? "" : "s"} (+${diffTotals.added} ~${diffTotals.modified} -${diffTotals.removed})`
      : ` (${scopeNames.length} scope${scopeNames.length === 1 ? "" : "s"})`;

    const payload = {
      type: "promote" as const,
      environment: `${task.source.environment} → ${task.target.environment}`,
      source: task.source,
      target: task.target,
      scopes: scopeNames.length ? scopeNames : ["all"],
      status: (promoteStatus === "done" ? "success" : "failed") as "success" | "failed",
      startedAt: started.iso,
      durationMs: completedMs - started.ms,
      summary: summaryBase + summaryDetail,
      taskId: task.id,
      taskName: task.name,
      phaseOutcomes,
      items: itemsList,
      diffTotals,
      phaseTimings,
      report: dryRunReport ?? undefined,
    };
    // Suppress unused warning for completedAt (kept for potential future use)
    void completedAt;

    // Save summary data to the task for the archive view
    const promoteTimings = phaseTimingsRef.current;
    const taskPatch: Record<string, unknown> = {
      phaseOutcomes,
      phaseTimings,
      promotedAt: promoteTimings.promote?.startedAt ?? started.iso,
      completedAt: new Date(completedMs).toISOString(),
      verifyChanges: verifyReport
        ? verifyReport.summary.added + verifyReport.summary.modified + verifyReport.summary.removed
        : null,
    };
    // Persist logs for both succeeded and failed tasks so they survive
    // page refresh, archive/restore, and tab switches.
    {
      const visible = promoteLogs.filter(
        (l) => l.type === "stdout" || l.type === "stderr" || l.type === "error",
      );
      taskPatch.promoteLogs = visible.map((l) => ({
        type: l.type as "stdout" | "stderr" | "error",
        data: l.data ?? "",
      }));
      taskPatch.errorLogs = visible
        .filter((l) => l.type === "stderr" || l.type === "error")
        .map((l) => ({ type: l.type as "stderr" | "error", data: l.data ?? "" }));
    }

    fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.id && dryRunReport) taskPatch.reportId = data.id;
        // Save all summary data to the task
        fetch(`/api/promotion-tasks/${task.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(taskPatch),
        }).catch(() => { /* non-fatal */ });
      })
      .catch(() => { /* non-fatal */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseStatuses.promote, phaseStatuses["dry-run"], phaseStatuses.summary]);

  // Auto-advance to summary when promote completes
  useEffect(() => {
    const promoteStatus = phaseStatuses.promote;
    if (promoteStatus === "done" || promoteStatus === "failed") {
      updatePhase("summary", promoteStatus === "done" ? "done" : "failed");
      setActivePhase("summary");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseStatuses.promote]);

  const handleRestart = () => {
    setPhaseStatuses({
      "dry-run": frConfigScopes.length > 0 ? "pending" : "skipped",
      promote: "pending",
      summary: "pending",
    });
    setActivePhase("dry-run");
    setDryRunReport(null);
    setVerifyReport(null);
    setPromoteLogs([]);
    setRestartKey((k) => k + 1);
    historyEmittedRef.current = false;
    runStartedAtRef.current = null;
    setDirty(false);
    // Reset task status back to new
    onTaskStatusChange("new");
  };

  const activeIdx = PHASE_DEFS.findIndex((p) => p.id === activePhase);
  const prevPhase = PHASE_DEFS
    .slice(0, activeIdx)
    .reverse()
    .find((p) => phaseStatuses[p.id] !== "skipped") ?? null;
  const nextPhase = PHASE_DEFS
    .slice(activeIdx + 1)
    .find((p) => phaseStatuses[p.id] !== "skipped") ?? null;

  if (task.items.length === 0) {
    return (
      <div className="p-4">
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          No scope items selected — edit the task to choose what to promote before running.
        </p>
      </div>
    );
  }

  const renderPhaseNav = () => (
    <>
      {prevPhase && activePhase !== "summary" && (
        <button
          type="button"
          onClick={() => setActivePhase(prevPhase.id)}
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {prevPhase.label}
        </button>
      )}
      {nextPhase && (() => {
        const blocked =
          (nextPhase.id === "promote" && phaseStatuses["dry-run"] !== "done" && phaseStatuses["dry-run"] !== "skipped") ||
          (nextPhase.id === "summary" && phaseStatuses.promote !== "done" && phaseStatuses.promote !== "failed");

        return (
          <button
            type="button"
            disabled={blocked}
            title={blocked ? "Run the dry-run comparison first" : undefined}
            onClick={async () => {
              if (blocked) return;
              if (
                nextPhase.id === "dry-run" &&
                task.target.mode === "local"
              ) {
                const ok = await confirm({
                  title: "Local target mode",
                  message: `The task target "${task.target.environment}" is set to Local mode.\n\nDry run compares the source against the target environment. A local target means no live remote data will be fetched.\n\nContinue anyway?`,
                  confirmLabel: "Continue",
                  variant: "warning",
                });
                if (!ok) return;
              }
              setActivePhase(nextPhase.id);
            }}
            className={cn(
              "flex items-center gap-1 text-xs transition-colors",
              blocked
                ? "text-slate-300 cursor-not-allowed"
                : "text-sky-600 hover:text-sky-800"
            )}
          >
            Next: {nextPhase.label}
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        );
      })()}
    </>
  );

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <Stepper statuses={phaseStatuses} active={activePhase} onClick={setActivePhase} />
        </div>
        {(phaseStatuses.promote === "done" || phaseStatuses.promote === "failed") && (
          <button
            type="button"
            onClick={onArchive}
            className="px-3 py-1.5 text-xs font-medium rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 transition-colors shrink-0"
          >
            Move to Archive
          </button>
        )}
      </div>

      <div className="border-t border-slate-100 pt-4 space-y-3">
        {/* Phase header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold text-slate-700">
              Phase {PHASE_DEFS.findIndex((p) => p.id === activePhase) + 1}: {PHASE_DEFS.find((p) => p.id === activePhase)?.label}
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {PHASE_DEFS.find((p) => p.id === activePhase)?.description}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {renderPhaseNav()}
          </div>
        </div>

        {/* All phase panels — always mounted, only active one visible */}
        <DryRunPhase
          key={`dry-run-${restartKey}`}
          task={task}
          visible={activePhase === "dry-run"}
          includeDeps={includeDeps}
          onIncludeDepsChange={setIncludeDeps}
          hasJourneys={hasJourneys}
          onComplete={(s) => updatePhase("dry-run", s)}
          onReport={setDryRunReport}
        />
        <PromotePhase
          key={`promote-${restartKey}`}
          task={task}
          frConfigScopes={frConfigScopes}
          frodoScopes={frodoScopes}
          igaScopes={igaScopes}
          targetIsControlled={(() => { const t = environments.find((e) => e.name === task.target.environment); return t?.type === "controlled" && !t?.devEnvironment; })()}
          isProdTarget={environments.find((e) => e.name === task.target.environment)?.color === "red"}
          visible={activePhase === "promote"}
          includeDeps={hasJourneys ? includeDeps : false}
          dryRunReport={dryRunReport}
          onVerifyReport={setVerifyReport}
          onPromoteLogs={setPromoteLogs}
          onComplete={(s) => updatePhase("promote", s)}
          onTaskStatusChange={onTaskStatusChange}
        />
        <SummaryPhase
          task={task}
          visible={activePhase === "summary"}
          dryRunReport={dryRunReport}
          verifyReport={verifyReport}
          promoteLogs={promoteLogs}
          phaseStatuses={phaseStatuses}
          onArchive={onArchive}
          onRestart={handleRestart}
        />

        {(prevPhase || nextPhase) && (
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
            {renderPhaseNav()}
          </div>
        )}
      </div>
    </div>
  );
}
