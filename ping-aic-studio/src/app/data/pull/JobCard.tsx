// src/app/data/pull/JobCard.tsx
"use client";

import type { DataPullJob } from "@/lib/data/types";
import { cn } from "@/lib/utils";
import { computeOverall } from "./job-progress";

export type JobCardStatus = DataPullJob["status"];

export interface JobCardRow {
  /** Type (managed) or source (logs). */
  label: string;
  fetched: number;
  /** Count denominator → "x / y" label + ETA. null → no count total (e.g. logs). */
  expected: number | null;
  /** Marks the expected value as probe-sourced (managed only) → renders a `*`. */
  expectedFromProbe?: boolean;
  /**
   * Progress fraction (0..1) for the BAR when it isn't count-based — logs use
   * time-window coverage here since they have no count total. When omitted, the
   * bar is derived from fetched/expected. null = indeterminate (show a sweep).
   */
  coverage?: number | null;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  /** Extra inline note shown under the bar (e.g. live "9:49 AM · EVENT" for logs). */
  detail?: string;
}

export interface JobCardModel {
  id: string;
  env: string;
  status: JobCardStatus;
  startedAt: number;
  fatalError?: string;
  /** Pull kind — drives overall-progress math and the count/unit nouns. */
  kind: "managed" | "logs";
  progress: JobCardRow[];
}

const STATUS_STYLE: Record<JobCardStatus, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-100 text-sky-700",
  aborting: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  aborted: "bg-slate-100 text-slate-500",
  interrupted: "bg-amber-100 text-amber-800",
  suspending: "bg-indigo-100 text-indigo-700",
  suspended: "bg-indigo-100 text-indigo-800",
};

const MIN_ELAPSED_FOR_ETA_MS = 10_000;

function timeAgo(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(ms).toLocaleTimeString();
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

/** Presentation-only job card over a normalized model (managed + log pulls). */
export function JobCard({
  model,
  onAbort,
  onResume,
  onSuspend,
}: {
  model: JobCardModel;
  onAbort: () => void;
  onResume?: () => void;
  onSuspend?: () => void;
}) {
  const canAbort = model.status === "running" || model.status === "queued" || model.status === "interrupted" || model.status === "suspended";
  const canSuspend = model.status === "running" || model.status === "queued";
  const canResume = model.status === "interrupted" || model.status === "suspended";
  const isRunning = model.status === "running" || model.status === "queued" || model.status === "aborting" || model.status === "suspending";
  // eslint-disable-next-line react-hooks/purity
  const elapsedMs = Date.now() - model.startedAt;

  // Header ETA only when every row's expected is known (else a partial total misleads).
  let totalFetched = 0;
  let totalExpected = 0;
  let anyUnknown = false;
  for (const p of model.progress) {
    totalFetched += p.fetched;
    if (p.expected === null) anyUnknown = true;
    else totalExpected += p.expected;
  }
  const etaMs = (
    isRunning
    && !anyUnknown
    && elapsedMs >= MIN_ELAPSED_FOR_ETA_MS
    && totalFetched > 0
    && totalExpected > totalFetched
  )
    ? Math.round((totalExpected - totalFetched) * (elapsedMs / totalFetched))
    : null;
  const ratePerSec = isRunning && elapsedMs >= MIN_ELAPSED_FOR_ETA_MS && totalFetched > 0
    ? totalFetched / (elapsedMs / 1000)
    : null;

  // Overall progress (shown for multi-unit jobs): mean coverage for logs,
  // Σfetched/Σtotal for managed, done/total fallback when a total is unknown.
  const overall = computeOverall(model.kind, model.progress);
  const showOverall = overall.totalUnits > 1;
  const countNoun = model.kind === "logs" ? "events" : "records";
  const unitNoun = model.kind === "logs" ? "sources" : "types";
  const allDone = overall.doneUnits === overall.totalUnits;
  const overallBar = allDone ? "bg-emerald-500" : "bg-gradient-to-r from-sky-400 to-sky-600";

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-xs text-slate-500">{model.env}</span>
        <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold rounded", STATUS_STYLE[model.status])}>
          {model.status}
        </span>
        <span className="text-xs text-slate-500">started {timeAgo(model.startedAt)}</span>
        {etaMs !== null && (
          <span
            className="text-xs text-sky-700"
            title={ratePerSec ? `${Math.round(ratePerSec).toLocaleString()} records/sec` : undefined}
          >
            · ~{formatDuration(etaMs)} remaining
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canSuspend && onSuspend && (
            <button
              type="button"
              onClick={onSuspend}
              title="Pause this pull. You can resume it later (even after a server restart) and it will continue from where it left off."
              className="px-2 py-0.5 text-xs border border-indigo-400 rounded bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
            >Suspend</button>
          )}
          {canResume && onResume && (
            <button
              type="button"
              onClick={onResume}
              className="px-2 py-0.5 text-xs border border-amber-400 rounded bg-amber-50 text-amber-800 hover:bg-amber-100"
            >Resume</button>
          )}
          {canAbort && (
            <button
              type="button"
              onClick={onAbort}
              title={canResume ? "Discard this paused pull and free the env so a fresh pull can start." : undefined}
              className="px-2 py-0.5 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
            >Abort</button>
          )}
        </div>
      </div>
      {showOverall && (
        <div className="space-y-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="tabular-nums font-semibold text-slate-700">{overall.count.toLocaleString()}</span>
            <span className="text-slate-500">{countNoun}</span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-500 tabular-nums">{overall.doneUnits}/{overall.totalUnits} {unitNoun}</span>
            {overall.pct !== null && (
              <span
                className="ml-auto tabular-nums font-semibold text-sky-700"
                title={overall.exact ? undefined : "Estimated from units completed (a source/type total is unknown)"}
              >
                {overall.pct}%{overall.exact ? "" : "≈"}
              </span>
            )}
          </div>
          <div className="h-1.5 bg-slate-100 rounded overflow-hidden">
            {overall.pct !== null && (
              <div className={cn("h-full rounded transition-[width] duration-500", overallBar)} style={{ width: `${overall.pct}%` }} />
            )}
          </div>
        </div>
      )}
      {model.fatalError && (
        <div className={cn(
          "px-2 py-1.5 border text-xs rounded font-mono break-all",
          model.status === "suspended" || model.status === "suspending"
            ? "bg-indigo-50 border-indigo-200 text-indigo-800"
            : "bg-rose-50 border-rose-200 text-rose-700",
        )}>
          {model.fatalError}
        </div>
      )}
      <div className="space-y-1">
        {model.progress.map((p) => {
          // Bar fraction: done → full; explicit coverage (logs use time-window
          // coverage); else count-based fetched/expected; else null. A null bar
          // on an active row renders an indeterminate sweep instead of empty.
          const barPct =
            p.status === "done" ? 100
              : p.coverage != null ? Math.min(100, Math.max(0, Math.round(p.coverage * 100)))
                : (p.expected !== null && p.expected > 0) ? Math.min(100, Math.round((p.fetched / p.expected) * 100))
                  : null;
          const barColor = p.status === "failed" ? "bg-rose-400" : p.status === "done" ? "bg-emerald-500" : "bg-sky-500";
          const indeterminate = barPct === null && p.status === "running";
          const barTitle = p.expected === null && p.coverage != null ? "time window covered" : undefined;
          return (
            <div key={p.label} className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-slate-700 w-40 truncate" title={p.label}>{p.label}</span>
                <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden" title={barTitle}>
                  {barPct !== null ? (
                    <div
                      className={cn("h-full rounded transition-[width] duration-500", barColor)}
                      style={{ width: `${barPct}%` }}
                    />
                  ) : indeterminate ? (
                    <div className="h-full w-1/5 bg-sky-500 rounded-full animate-progress-slide" />
                  ) : null}
                </div>
                <span
                  className="text-slate-500 tabular-nums w-28 text-right"
                  title={p.expectedFromProbe ? "Denominator from the Probe counts value" : undefined}
                >
                  {p.fetched.toLocaleString()}
                  {p.expected !== null ? ` / ${p.expected.toLocaleString()}${p.expectedFromProbe ? "*" : ""}` : ""}
                </span>
                <span className={cn("text-[10px] w-16", p.status === "failed" ? "text-rose-600 font-semibold" : "text-slate-400")}>
                  {p.status}
                </span>
              </div>
              {p.detail && p.status !== "failed" && (
                <div className="ml-40 pl-2 text-[10px] text-slate-400 truncate" title={p.detail}>{p.detail}</div>
              )}
              {p.status === "failed" && p.error && (
                <div className="ml-40 pl-2 text-[11px] text-rose-700 bg-rose-50 border-l-2 border-rose-300 px-2 py-1 rounded-r font-mono break-all">
                  {p.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
