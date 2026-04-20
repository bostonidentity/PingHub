"use client";

import { useState, useEffect } from "react";
import { Environment, ConfigScope } from "@/lib/fr-config-types";
import { ScopeSelector } from "@/components/ScopeSelector";
import { ScopedLogViewer } from "@/components/ScopedLogViewer";
import { useStreamingLogs } from "@/hooks/useStreamingLogs";
import { useBusyState } from "@/hooks/useBusyState";
import { DiffReport } from "./DiffReport";
import { cn } from "@/lib/utils";
import type { PromotionTask } from "@/lib/promotion-tasks";

type Mode = "local" | "remote";

interface Endpoint {
  environment: string;
  mode: Mode;
}

// ── Endpoint selector ─────────────────────────────────────────────────────────

function EndpointSelector({
  label,
  value,
  onChange,
  environments,
  disabled,
}: {
  label: string;
  value: Endpoint;
  onChange: (v: Endpoint) => void;
  environments: Environment[];
  disabled?: boolean;
}) {
  return (
    <div className="flex-1 space-y-2.5 p-4 bg-slate-50 rounded-lg border border-slate-200">
      <div className="label-xs">{label}</div>
      <select
        value={value.environment}
        onChange={(e) => onChange({ ...value, environment: e.target.value })}
        disabled={disabled}
        className="block w-full px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 bg-white"
      >
        {environments.map((env) => (
          <option key={env.name} value={env.name}>{env.label}</option>
        ))}
      </select>
      <div className="flex gap-1.5">
        {(["local", "remote"] as Mode[]).map((m) => (
          <label
            key={m}
            className={cn(
              "flex-1 flex items-center justify-center py-1.5 rounded border text-xs font-medium transition-colors select-none",
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
              value.mode === m
                ? "bg-sky-600 border-sky-600 text-white"
                : "bg-white border-slate-300 text-slate-600 hover:border-sky-400"
            )}
          >
            <input
              type="radio"
              className="sr-only"
              value={m}
              checked={value.mode === m}
              onChange={() => !disabled && onChange({ ...value, mode: m })}
              disabled={disabled}
            />
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Local config placeholder ───────────────────────────────────────────────────

function LocalPanel({ envName, done }: { envName: string; done: boolean }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-800 border-b border-slate-700">
        <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", done ? "bg-green-400" : "bg-slate-500")} />
        <span className="text-xs font-mono text-slate-400">
          {done ? "Local config ready" : "Local config"}
        </span>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center py-10 bg-slate-900 text-center">
        <svg className="w-6 h-6 text-slate-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <p className="text-xs text-slate-500">Local config</p>
        <p className="text-xs font-mono text-slate-600 mt-0.5">{envName}</p>
      </div>
    </div>
  );
}

// ── Panel header ──────────────────────────────────────────────────────────────

function PanelHeader({ label }: { label: string }) {
  return (
    <div className="px-3 py-1.5 bg-slate-700 border-b border-slate-600">
      <span className="text-[10px] font-semibold text-slate-300 uppercase tracking-widest">{label}</span>
    </div>
  );
}

// ── Module-level cache — survives React unmount/remount from tab navigation ───

interface FormCache {
  source?: Endpoint;
  target?: Endpoint;
  scopes?: ConfigScope[];
  includeMetadata?: boolean;
  report?: import("@/lib/diff-types").CompareReport | null;
}
const formCache: FormCache = {};

// ── Recent scope sets ─────────────────────────────────────────────────────────

const RECENT_SCOPES_KEY = "compare-recent-scopes";
const MAX_RECENT_SCOPES = 8;

interface RecentScopeSet {
  scopes: ConfigScope[];
  lastUsed: number;
}

function canonicalScopeKey(scopes: ConfigScope[]): string {
  return [...scopes].sort().join(",");
}

function loadRecentScopes(): RecentScopeSet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_SCOPES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is RecentScopeSet =>
      e && Array.isArray(e.scopes) && typeof e.lastUsed === "number",
    );
  } catch {
    return [];
  }
}

function saveRecentScopes(scopes: ConfigScope[]): RecentScopeSet[] {
  if (typeof window === "undefined" || scopes.length === 0) return loadRecentScopes();
  const key = canonicalScopeKey(scopes);
  const current = loadRecentScopes().filter((e) => canonicalScopeKey(e.scopes) !== key);
  const next = [{ scopes: [...scopes], lastUsed: Date.now() }, ...current].slice(0, MAX_RECENT_SCOPES);
  try {
    window.localStorage.setItem(RECENT_SCOPES_KEY, JSON.stringify(next));
  } catch { /* quota */ }
  return next;
}

function removeRecentScope(key: string): RecentScopeSet[] {
  if (typeof window === "undefined") return [];
  const next = loadRecentScopes().filter((e) => canonicalScopeKey(e.scopes) !== key);
  try {
    window.localStorage.setItem(RECENT_SCOPES_KEY, JSON.stringify(next));
  } catch { /* quota */ }
  return next;
}

function formatScopeList(scopes: ConfigScope[]): string {
  return scopes.map((s) => s.replace(/-/g, " ")).join(", ");
}

// ── Main form ─────────────────────────────────────────────────────────────────

export function CompareForm({ environments, tasks = [] }: { environments: Environment[]; tasks?: PromotionTask[] }) {
  const defaultEnv = environments[0]?.name ?? "";

  const [source, setSource] = useState<Endpoint>(formCache.source ?? { environment: defaultEnv, mode: "local" });
  const [target, setTarget] = useState<Endpoint>(formCache.target ?? { environment: defaultEnv, mode: "remote" });
  const [scopes, setScopes] = useState<ConfigScope[]>(formCache.scopes ?? []);
  const [includeMetadata, setIncludeMetadata] = useState<boolean>(formCache.includeMetadata ?? false);
  const [recentScopes, setRecentScopes] = useState<RecentScopeSet[]>([]);

  // Rehydrate recent-scope history after mount to avoid SSR/CSR mismatch.
  useEffect(() => { setRecentScopes(loadRecentScopes()); }, []);

  const { logs, running, sourceExitCode, targetExitCode, report, run, abort, clear } =
    useStreamingLogs();
  const { setBusy } = useBusyState();

  // Write-through: keep cache in sync with form inputs
  useEffect(() => { formCache.source = source; }, [source]);
  useEffect(() => { formCache.target = target; }, [target]);
  useEffect(() => { formCache.scopes = scopes; }, [scopes]);
  useEffect(() => { formCache.includeMetadata = includeMetadata; }, [includeMetadata]);
  useEffect(() => { if (report) formCache.report = report; }, [report]);

  // Live report takes priority; fall back to cache from previous run
  const displayReport = report ?? formCache.report ?? null;

  useEffect(() => { setBusy(running); }, [running, setBusy]);

  const sourceLogs = logs.filter((l) => l.side === "source");
  const targetLogs = logs.filter((l) => l.side === "target");
  const sourceRunning = running && sourceExitCode === null;
  const targetRunning = running && targetExitCode === null;

  const showConsole = logs.length > 0 || running;

  const handleCompare = () => {
    setRecentScopes(saveRecentScopes(scopes));
    run("/api/compare", {
      source,
      target,
      scopes,
      mode: "compare",
      diffOptions: { includeMetadata, ignoreWhitespace: true },
    });
  };

  const handleRemoveRecent = (key: string) => {
    setRecentScopes(removeRecentScope(key));
  };

  return (
    <div className="space-y-6">
      {/* ── Selector card ────────────────────────────────────────────────── */}
      <div className="card-padded space-y-4">
        <div className="flex items-stretch gap-3">
          <EndpointSelector
            label="Source"
            value={source}
            onChange={setSource}
            environments={environments}
            disabled={running}
          />

          <div className="flex flex-col items-center justify-center shrink-0 self-center mt-5 gap-1.5">
            <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            <button
              type="button"
              title="Swap source and target"
              disabled={running}
              onClick={() => { setSource(target); setTarget(source); }}
              className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-40 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M16 4l4 4-4 4M20 16H4M8 12l-4 4 4 4" />
              </svg>
            </button>
          </div>

          <EndpointSelector
            label="Target"
            value={target}
            onChange={setTarget}
            environments={environments}
            disabled={running}
          />
        </div>

        {recentScopes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-slate-500 mr-0.5">Recent:</span>
            {recentScopes.map((entry) => {
              const key = canonicalScopeKey(entry.scopes);
              const active = canonicalScopeKey(scopes) === key;
              return (
                <span
                  key={key}
                  className={cn(
                    "group inline-flex items-center gap-1 rounded-full ring-1 text-[11px] overflow-hidden transition-colors",
                    active
                      ? "bg-indigo-50 text-indigo-700 ring-indigo-200"
                      : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                  )}
                >
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => setScopes([...entry.scopes])}
                    title={`Apply ${entry.scopes.length} scope${entry.scopes.length === 1 ? "" : "s"}: ${formatScopeList(entry.scopes)}`}
                    className="px-2.5 py-0.5 max-w-[320px] truncate disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {entry.scopes.length === 1
                      ? formatScopeList(entry.scopes)
                      : `${entry.scopes.length} scopes · ${formatScopeList(entry.scopes)}`}
                  </button>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => handleRemoveRecent(key)}
                    title="Remove from recent"
                    aria-label="Remove from recent"
                    className="pr-1.5 pl-0.5 text-slate-400 hover:text-rose-500 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <ScopeSelector selected={scopes} onChange={setScopes} disabled={running} action="compare" />

        <div className="flex gap-3 items-center">
          <button
            type="button"
            onClick={handleCompare}
            disabled={running || !source.environment || !target.environment || scopes.length === 0}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? "Comparing…" : "Compare"}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeMetadata}
              onChange={(e) => setIncludeMetadata(e.target.checked)}
              disabled={running}
              className="accent-sky-600"
            />
            Include metadata (createdBy, dates, etc.)
          </label>
          {running && (
            <button
              type="button"
              onClick={abort}
              className="btn-secondary"
            >
              Abort
            </button>
          )}
        </div>
      </div>

      {/* ── Console panels ───────────────────────────────────────────────── */}
      {showConsole && (
        <div className="rounded-lg border border-slate-700 overflow-hidden grid grid-cols-2 divide-x divide-slate-700">
          {/* Source */}
          <div className="min-w-0 flex flex-col">
            <PanelHeader label={`Source — ${source.environment}${source.mode === "local" ? " (local)" : ""}`} />
            {source.mode === "local" ? (
              <LocalPanel envName={source.environment} done={sourceExitCode !== null} />
            ) : (
              <ScopedLogViewer
                logs={sourceLogs}
                running={sourceRunning}
                exitCode={sourceExitCode}
                onClear={!running ? clear : undefined}
              />
            )}
          </div>

          {/* Target */}
          <div className="min-w-0 flex flex-col">
            <PanelHeader label={`Target — ${target.environment}${target.mode === "local" ? " (local)" : ""}`} />
            {target.mode === "local" ? (
              <LocalPanel envName={target.environment} done={targetExitCode !== null} />
            ) : (
              <ScopedLogViewer
                logs={targetLogs}
                running={targetRunning}
                exitCode={targetExitCode}
                onClear={!running ? clear : undefined}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Diff report ──────────────────────────────────────────────────── */}
      {displayReport && !running && <DiffReport report={displayReport} tasks={tasks} />}
    </div>
  );
}
