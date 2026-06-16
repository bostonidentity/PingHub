"use client";
import { useEffect, useState, useCallback } from "react";
import {
  CalendarClock, CircleCheck, Timer, Clock, Sun, CalendarDays, Terminal,
  RefreshCw, Database, GitCommitHorizontal, Play, Pencil, Trash2,
  ChevronRight, Plus, Loader2, Zap,
} from "lucide-react";
import type { Schedule, Step } from "@/lib/scheduler/types";
import type { Environment } from "@/lib/fr-config";
import { ScheduleEditor } from "./ScheduleEditor";

// ── helpers ──────────────────────────────────────────────────────────────────

const ENV_DOT: Record<string, string> = {
  blue: "bg-blue-400", yellow: "bg-amber-400", red: "bg-rose-400",
  green: "bg-emerald-400", purple: "bg-purple-400", orange: "bg-orange-400",
  teal: "bg-teal-400", pink: "bg-pink-400", indigo: "bg-indigo-400", gray: "bg-slate-400",
};


function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

function triggerInfo(s: Schedule): { Icon: React.ComponentType<{ className?: string }>; text: string } {
  const t = s.trigger;
  if (t.kind === "cron") return { Icon: Terminal, text: `cron: ${t.cron}` };
  const p = t.preset!;
  if (p.every === "hour") return { Icon: Clock, text: `Hourly at :${String(p.minute).padStart(2, "0")}` };
  if (p.every === "day") return { Icon: Sun, text: `Daily ${p.time}` };
  const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return { Icon: CalendarDays, text: `Weekly · ${p.days.map((d) => dayNames[d]).join(",")} ${p.time}` };
}

function accentColor(s: Schedule): string {
  if (!s.enabled) return "#cbd5e1";
  if (!s.lastRun) return "#818cf8";
  if (s.lastRun.status === "success") return "#34d399";
  if (s.lastRun.status === "failed") return "#fb7185";
  return "#fbbf24";
}

function StepChip({ step, environments }: { step: Step; environments: Environment[] }) {
  const typeMap = {
    sync: { label: "Sync", Icon: RefreshCw, cls: "bg-sky-50 text-sky-600 border-sky-100" },
    "pull-data": { label: "Pull data", Icon: Database, cls: "bg-violet-50 text-violet-600 border-violet-100" },
    "git-push": { label: "Commit & push", Icon: GitCommitHorizontal, cls: "bg-emerald-50 text-emerald-600 border-emerald-100" },
  } as const;
  const meta = typeMap[step.type];
  let detail = "";
  let envName = "";
  if (step.type === "sync") {
    detail = step.scopes.length ? `${step.scopes.length} scope${step.scopes.length !== 1 ? "s" : ""}` : "all scopes";
    envName = step.environment;
  } else if (step.type === "pull-data") {
    detail = step.managedObjects.length ? step.managedObjects.join(", ") : "no objects";
    envName = step.environment;
  } else {
    detail = "commit & push";
  }
  const env = environments.find((e) => e.name === envName);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border border-slate-200 bg-white">
      <span className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${meta.cls}`}>
        <meta.Icon className="w-3 h-3" />
      </span>
      <span className="font-medium text-slate-700">{meta.label}</span>
      {env && (
        <>
          <span className="text-slate-300">·</span>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ENV_DOT[env.color] ?? "bg-slate-400"}`} />
          <span className="text-slate-500">{env.label}</span>
        </>
      )}
      <span className="text-slate-400">{detail}</span>
    </span>
  );
}

// ── Switch ────────────────────────────────────────────────────────────────────

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative inline-flex h-[22px] w-[38px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 ${checked ? "bg-indigo-600" : "bg-slate-300"}`}
    >
      <span
        className={`pointer-events-none inline-block h-[18px] w-[18px] translate-y-[2px] rounded-full bg-white shadow transition-transform duration-200 ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}`}
      />
    </button>
  );
}

// ── ScheduleList ──────────────────────────────────────────────────────────────

export function ScheduleList({ environments = [], typesByEnv = {} }: {
  environments?: Environment[];
  typesByEnv?: Record<string, string[]>;
} = {}) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | "new" | Schedule>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runsToday, setRunsToday] = useState(0);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSchedules(await res.json());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/history");
        if (!res.ok) return;
        const records: Array<{ trigger?: string; startedAt?: string; completedAt?: string }> = await res.json();
        const today = new Date().toISOString().slice(0, 10);
        setRunsToday(records.filter((r) =>
          r.trigger === "scheduled" &&
          (r.startedAt ?? r.completedAt ?? "").startsWith(today)
        ).length);
      } catch { /* silent */ }
    })();
  }, [schedules]);

  const runNow = async (id: string) => {
    setRunning((p) => ({ ...p, [id]: true }));
    await fetch(`/api/schedules/${id}/run`, { method: "POST" });
    setRunning((p) => ({ ...p, [id]: false }));
    void reload();
  };
  const toggle = async (s: Schedule) => {
    await fetch(`/api/schedules/${s.id}`, { method: "PUT", body: JSON.stringify({ enabled: !s.enabled }) });
    void reload();
  };
  const remove = async (id: string) => {
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    void reload();
  };

  const enabled = schedules.filter((s) => s.enabled);
  const nextRuns = enabled.map((s) => new Date(s.nextRunAt).getTime()).filter((t) => t > Date.now());
  const nextRunText = nextRuns.length ? timeUntil(new Date(Math.min(...nextRuns)).toISOString()) : "—";

  if (error) return <div className="p-4 text-red-600">Failed to load schedules: {error}</div>;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="page-title">Scheduler</h1>
          <p className="text-sm text-slate-500 mt-1">Run sync, data pulls and git pushes on a timer — single tasks or pipelines. Runs while PingHub is open.</p>
        </div>
        <button onClick={() => setEditing("new")} className="btn-primary flex-shrink-0">
          <Plus className="w-4 h-4" /> New schedule
        </button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="card px-4 py-3 flex items-center gap-3">
          <div className="w-[30px] h-[30px] rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center flex-shrink-0">
            <CalendarClock className="w-[15px] h-[15px]" />
          </div>
          <div>
            <div className="text-xl font-bold text-slate-900">{enabled.length}</div>
            <div className="text-xs text-slate-500">Active schedules</div>
          </div>
        </div>
        <div className="card px-4 py-3 flex items-center gap-3">
          <div className="w-[30px] h-[30px] rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
            <CircleCheck className="w-[15px] h-[15px]" />
          </div>
          <div>
            <div className="text-xl font-bold text-slate-900">{runsToday}</div>
            <div className="text-xs text-slate-500">Runs today</div>
          </div>
        </div>
        <div className="card px-4 py-3 flex items-center gap-3">
          <div className="w-[30px] h-[30px] rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0">
            <Timer className="w-[15px] h-[15px]" />
          </div>
          <div>
            <div className="text-xl font-bold text-slate-900">{nextRunText}</div>
            <div className="text-xs text-slate-500">Next run in</div>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Schedules</div>

      {schedules.length === 0 ? (
        <div className="border-2 border-dashed border-slate-200 rounded-xl p-12 text-center">
          <p className="text-slate-500">No schedules yet — create one with “New schedule” above.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => {
            const { Icon: TrigIcon, text: trigText } = triggerInfo(s);
            return (
              <div key={s.id} className={`card overflow-hidden ${!s.enabled ? "opacity-70" : ""}`} style={{ borderLeft: `3px solid ${accentColor(s)}` }}>
                <div className="flex">
                  {/* Main content */}
                  <div className="flex-1 p-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-[15px] text-slate-900">{s.name}</span>
                      {s.enabled
                        ? <span className="pill-info"><Zap className="w-[11px] h-[11px]" />Active</span>
                        : <span className="pill-neutral">Paused</span>
                      }
                      {s.steps.length > 1 && (
                        <span className="pill-neutral">{s.steps.length}-step pipeline</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[13px] text-slate-500 flex-wrap">
                      <span className="inline-flex items-center gap-1.5">
                        <TrigIcon className="w-[14px] h-[14px]" />{trigText}
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="inline-flex items-center gap-1.5">
                        next {s.enabled ? timeUntil(s.nextRunAt) : "paused"}
                      </span>
                      {s.lastRun && (
                        <>
                          <span className="text-slate-300">·</span>
                          <span className="inline-flex items-center gap-1.5">
                            last{" "}
                            {s.lastRun.status === "success"
                              ? <span className="pill-success">{s.lastRun.status}</span>
                              : s.lastRun.status === "failed"
                              ? <span className="pill-danger">{s.lastRun.status}</span>
                              : <span className="pill-warning">{s.lastRun.status}</span>
                            }
                          </span>
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-3">
                      {s.steps.map((step, idx) => (
                        <span key={idx} className="inline-flex items-center gap-1.5">
                          <StepChip step={step} environments={environments} />
                          {idx < s.steps.length - 1 && <ChevronRight className="w-[14px] h-[14px] text-slate-300" />}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Actions */}
                  <div className="flex flex-col items-end justify-between p-3 border-l border-slate-100 bg-slate-50/40 flex-shrink-0">
                    <Switch checked={s.enabled} onChange={() => toggle(s)} />
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => runNow(s.id)}
                        title="Run now"
                        className="btn-secondary !px-2.5 !py-1.5"
                        disabled={running[s.id]}
                      >
                        {running[s.id]
                          ? <Loader2 className="w-[13px] h-[13px] animate-spin" />
                          : <Play className="w-[13px] h-[13px]" />
                        }
                      </button>
                      <button
                        onClick={() => setEditing(s)}
                        title="Edit"
                        className="btn-secondary !px-2.5 !py-1.5"
                      >
                        <Pencil className="w-[13px] h-[13px]" />
                      </button>
                      <button
                        onClick={() => remove(s.id)}
                        title="Delete"
                        className="btn-danger-outline !px-2.5 !py-1.5"
                      >
                        <Trash2 className="w-[13px] h-[13px]" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Editor modal */}
      {editing !== null && (
        <ScheduleEditor
          initial={editing === "new" ? undefined : editing}
          environments={environments}
          typesByEnv={typesByEnv}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}
    </div>
  );
}
