"use client";
import { useMemo, useState } from "react";
import { X, Check, Plus, Trash2, RefreshCw, Database, GitCommitHorizontal } from "lucide-react";
import type { ScheduleInput, Step, SyncStep, PullDataStep, Trigger, Preset } from "@/lib/scheduler/types";
import type { Environment, ConfigScope } from "@/lib/fr-config";
import { CONFIG_SCOPES } from "@/lib/fr-config-types";

// ── Switch ──────────────────────────────────────────────────────────────────

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer">
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
      {label && <span className="text-sm text-slate-700">{label}</span>}
    </label>
  );
}

// ── ScheduleEditor ──────────────────────────────────────────────────────────

type TriggerKind = "hourly" | "daily" | "weekly" | "cron";

function getTriggerKind(trigger: Trigger): TriggerKind {
  if (trigger.kind === "cron") return "cron";
  const p = trigger.preset;
  if (!p) return "daily";
  if (p.every === "hour") return "hourly";
  if (p.every === "week") return "weekly";
  return "daily";
}

export function ScheduleEditor({
  initial,
  environments = [],
  typesByEnv = {},
  onClose,
  onSaved,
}: {
  initial?: ScheduleInput & { id?: string };
  environments?: Environment[];
  typesByEnv?: Record<string, string[]>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [trigger, setTrigger] = useState<Trigger>(
    initial?.trigger ?? { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: defaultTz }
  );
  const [onError, setOnError] = useState<"stop" | "continue">(initial?.onError ?? "stop");
  const [catchUpIfMissed, setCatchUp] = useState(initial?.catchUpIfMissed ?? true);
  const [steps, setSteps] = useState<Step[]>(initial?.steps ?? [{ type: "git-push" }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const triggerKind = getTriggerKind(trigger);

  const setTriggerKind = (kind: TriggerKind) => {
    const tz = trigger.timezone ?? defaultTz;
    if (kind === "cron") {
      setTrigger({ kind: "cron", cron: "0 2 * * *", timezone: tz });
    } else if (kind === "hourly") {
      setTrigger({ kind: "preset", preset: { every: "hour", minute: 0 }, timezone: tz });
    } else if (kind === "daily") {
      setTrigger({ kind: "preset", preset: { every: "day", time: "02:00" }, timezone: tz });
    } else {
      setTrigger({ kind: "preset", preset: { every: "week", days: [1], time: "02:00" }, timezone: tz });
    }
  };

  const scopeList = useMemo(() => {
    return CONFIG_SCOPES.filter((s) => s.cliSupported !== false).map((s) => ({
      value: s.value as ConfigScope,
      label: s.label,
    }));
  }, []);

  const updateStep = (i: number, next: Step) =>
    setSteps(steps.map((x, j) => (j === i ? next : x)));

  const toggleScope = (i: number, step: SyncStep, value: ConfigScope) => {
    const has = step.scopes.includes(value);
    updateStep(i, {
      ...step,
      scopes: has ? step.scopes.filter((v) => v !== value) : [...step.scopes, value],
    });
  };

  const toggleManagedObject = (i: number, step: PullDataStep, value: string) => {
    const has = step.managedObjects.includes(value);
    updateStep(i, {
      ...step,
      managedObjects: has
        ? step.managedObjects.filter((v) => v !== value)
        : [...step.managedObjects, value],
    });
  };

  const toggleEnv = (i: number, step: SyncStep | PullDataStep, env: string) => {
    const has = step.environments.includes(env);
    const environments = has ? step.environments.filter((e) => e !== env) : [...step.environments, env];
    if (step.type === "pull-data") {
      const union = new Set(environments.flatMap((e) => typesByEnv[e] ?? []));
      updateStep(i, { ...step, environments, managedObjects: step.managedObjects.filter((m) => union.has(m)) });
    } else {
      updateStep(i, { ...step, environments });
    }
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    const payload: ScheduleInput = { name, enabled, trigger, onError, catchUpIfMissed, steps };
    const url = initial?.id ? `/api/schedules/${initial.id}` : "/api/schedules";
    const method = initial?.id ? "PUT" : "POST";
    const res = await fetch(url, { method, body: JSON.stringify(payload) });
    setSaving(false);
    if (!res.ok) {
      setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      return;
    }
    onSaved();
    onClose();
  };

  const inputCls =
    "block w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-colors";
  const segBtnCls = (active: boolean) =>
    `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
      active
        ? "bg-white text-indigo-700 shadow-sm"
        : "text-slate-500 hover:text-slate-700"
    }`;
  const chipCls = (active: boolean) =>
    `inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
      active
        ? "bg-indigo-50 border-indigo-200 text-indigo-700"
        : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
    }`;

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-start justify-center p-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl my-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {initial?.id ? "Edit schedule" : "New schedule"}
            </h2>
            <p className="text-xs text-slate-500">Define a trigger and one or more steps.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto scrollbar-thin">
          {/* Name + enabled */}
          <div className="flex items-end gap-4">
            <label className="flex-1 block">
              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Name</span>
              <input
                aria-label="Name"
                className={`${inputCls} mt-1`}
                placeholder="e.g. Nightly backup"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="pb-2">
              <Switch checked={enabled} onChange={() => setEnabled(!enabled)} label="Enabled" />
            </div>
          </div>

          {/* Trigger */}
          <div>
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Trigger</span>
            <div className="flex items-center gap-3 flex-wrap">
              {/* Segmented control */}
              <div className="inline-flex bg-slate-100 border border-slate-200 rounded-lg p-[2px]" role="tablist">
                {(["hourly", "daily", "weekly", "cron"] as TriggerKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={triggerKind === k}
                    onClick={() => setTriggerKind(k)}
                    className={segBtnCls(triggerKind === k)}
                  >
                    {k.charAt(0).toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>

              {/* Hourly: minute */}
              {triggerKind === "hourly" && trigger.kind === "preset" && trigger.preset?.every === "hour" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">at minute</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    className={`${inputCls} w-20`}
                    value={trigger.preset.minute}
                    onChange={(e) =>
                      setTrigger({ ...trigger, preset: { every: "hour", minute: Number(e.target.value) } })
                    }
                  />
                </div>
              )}

              {/* Daily: time */}
              {triggerKind === "daily" && trigger.kind === "preset" && trigger.preset?.every === "day" && (
                <input
                  type="time"
                  aria-label="daily time"
                  className={`${inputCls} w-auto`}
                  value={trigger.preset.time}
                  onChange={(e) =>
                    setTrigger({ ...trigger, preset: { every: "day", time: e.target.value } })
                  }
                />
              )}

              {/* Weekly: days + time */}
              {triggerKind === "weekly" && trigger.kind === "preset" && trigger.preset?.every === "week" && (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex gap-1">
                    {DAY_NAMES.map((d, idx) => {
                      const days = (trigger.preset as Extract<Preset, { every: "week" }>).days;
                      const active = days.includes(idx);
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => {
                            const newDays = active ? days.filter((x) => x !== idx) : [...days, idx];
                            setTrigger({ ...trigger, preset: { every: "week", days: newDays, time: (trigger.preset as Extract<Preset, { every: "week" }>).time } });
                          }}
                          className={chipCls(active)}
                        >
                          {d}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="time"
                    aria-label="daily time"
                    className={`${inputCls} w-auto`}
                    value={(trigger.preset as Extract<Preset, { every: "week" }>).time}
                    onChange={(e) =>
                      setTrigger({ ...trigger, preset: { every: "week", days: (trigger.preset as Extract<Preset, { every: "week" }>).days, time: e.target.value } })
                    }
                  />
                </div>
              )}

              {/* Cron */}
              {triggerKind === "cron" && trigger.kind === "cron" && (
                <input
                  aria-label="cron"
                  className={`${inputCls} font-mono flex-1`}
                  placeholder="0 2 * * *"
                  value={trigger.cron ?? ""}
                  onChange={(e) => setTrigger({ ...trigger, cron: e.target.value })}
                />
              )}
            </div>
            {trigger.timezone && (
              <p className="text-xs text-slate-400 mt-1.5">timezone: {trigger.timezone}</p>
            )}
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Pipeline steps</span>
            </div>
            <div className="space-y-2">
              {steps.map((s, i) => {
                const typeIconMap = {
                  sync: { label: "Sync", Icon: RefreshCw, cls: "bg-sky-50 text-sky-600" },
                  "pull-data": { label: "Pull data", Icon: Database, cls: "bg-violet-50 text-violet-600" },
                  "git-push": { label: "Commit & push", Icon: GitCommitHorizontal, cls: "bg-emerald-50 text-emerald-600" },
                } as const;
                const meta = typeIconMap[s.type];
                return (
                  <div key={i} className="rounded-lg border border-slate-200 p-3 bg-white">
                    <div className="flex items-center gap-2">
                      <span className={`w-[30px] h-[30px] rounded-lg flex items-center justify-center flex-shrink-0 ${meta.cls}`}>
                        <meta.Icon className="w-[15px] h-[15px]" />
                      </span>
                      {/* Type select (keep aria-label for tests) */}
                      <select
                        aria-label={`step-${i}-type`}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 focus:outline-none focus:border-indigo-400"
                        value={s.type}
                        onChange={(e) => {
                          const type = e.target.value as Step["type"];
                          const next: Step =
                            type === "sync"
                              ? { type, environments: [], scopes: [] }
                              : type === "pull-data"
                              ? { type, environments: [], managedObjects: [] }
                              : { type: "git-push" };
                          updateStep(i, next);
                        }}
                      >
                        <option value="sync">Sync (config pull)</option>
                        <option value="pull-data">Pull data</option>
                        <option value="git-push">Commit &amp; push</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                        className="ml-auto text-slate-400 hover:text-rose-600 p-1 rounded-lg transition-colors"
                        title="Remove step"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Sync step */}
                    {s.type === "sync" && (
                      <div className="mt-3 space-y-3">
                        <div>
                          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Environments</span>
                          {environments.length === 0 ? (
                            <p className="mt-1 text-xs text-slate-400">No environments configured.</p>
                          ) : (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {environments.map((env) => {
                                const active = s.environments.includes(env.name);
                                return (
                                  <button
                                    key={env.name}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => toggleEnv(i, s, env.name)}
                                    className={chipCls(active)}
                                  >
                                    {active && <Check className="w-[10px] h-[10px]" />}
                                    {env.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {environments.length > 0 && s.environments.length === 0 && (
                            <p className="mt-1 text-xs text-slate-400">Select at least one environment.</p>
                          )}
                        </div>
                        <div>
                          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                            Scopes{" "}
                            <span className="text-slate-400 font-normal">
                              ({s.scopes.length ? `${s.scopes.length} selected` : "all"})
                            </span>
                          </span>
                          <div className="mt-1 flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                            {scopeList.map((sc) => {
                              const active = s.scopes.includes(sc.value);
                              return (
                                <button
                                  key={sc.value}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => toggleScope(i, s, sc.value)}
                                  className={chipCls(active)}
                                >
                                  {active && <Check className="w-[10px] h-[10px]" />}
                                  {sc.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Pull-data step */}
                    {s.type === "pull-data" && (
                      <div className="mt-3 space-y-3">
                        <div>
                          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Environments</span>
                          {environments.length === 0 ? (
                            <p className="mt-1 text-xs text-slate-400">No environments configured.</p>
                          ) : (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {environments.map((env) => {
                                const active = s.environments.includes(env.name);
                                return (
                                  <button
                                    key={env.name}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => toggleEnv(i, s, env.name)}
                                    className={chipCls(active)}
                                  >
                                    {active && <Check className="w-[10px] h-[10px]" />}
                                    {env.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {environments.length > 0 && s.environments.length === 0 && (
                            <p className="mt-1 text-xs text-slate-400">Select at least one environment.</p>
                          )}
                        </div>
                        <div>
                          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                            Managed objects{" "}
                            <span className="text-slate-400 font-normal">({s.managedObjects.length} selected)</span>
                          </span>
                          {s.environments.length === 0 ? (
                            <p className="mt-1 text-xs text-slate-400">Select an environment first.</p>
                          ) : (() => {
                            const union = [...new Set(s.environments.flatMap((e) => typesByEnv[e] ?? []))].sort();
                            return union.length === 0 ? (
                              <p className="mt-1 text-xs text-slate-400">No managed objects found.</p>
                            ) : (
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {union.map((mo) => {
                                  const active = s.managedObjects.includes(mo);
                                  return (
                                    <button
                                      key={mo}
                                      type="button"
                                      aria-pressed={active}
                                      onClick={() => toggleManagedObject(i, s, mo)}
                                      className={chipCls(active)}
                                    >
                                      {active && <Check className="w-[10px] h-[10px]" />}
                                      {mo}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Git-push step */}
                    {s.type === "git-push" && (
                      <label className="mt-3 block">
                        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                          Commit message <span className="text-slate-400 font-normal">(optional)</span>
                        </span>
                        <input
                          aria-label={`step-${i}-message`}
                          className={`${inputCls} mt-1`}
                          placeholder="chore(scheduler): automated backup"
                          value={s.message ?? ""}
                          onChange={(e) =>
                            updateStep(i, { ...s, message: e.target.value || undefined })
                          }
                        />
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setSteps([...steps, { type: "git-push" }])}
              className="btn-secondary mt-2 text-xs !py-1.5 !px-3"
            >
              <Plus className="w-3.5 h-3.5" /> Add step
            </button>
          </div>

          {/* Options */}
          <div className="grid grid-cols-2 gap-4 pt-1">
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">On step failure</span>
              <select
                className={`${inputCls} mt-1`}
                value={onError}
                onChange={(e) => setOnError(e.target.value as "stop" | "continue")}
              >
                <option value="stop">Stop pipeline</option>
                <option value="continue">Continue</option>
              </select>
            </label>
            <div className="flex items-center gap-2 pt-6">
              <Switch
                checked={catchUpIfMissed}
                onChange={() => setCatchUp(!catchUpIfMissed)}
                label="Run once on startup if missed"
              />
            </div>
          </div>

          {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-xl">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="btn-primary">
            <Check className="w-4 h-4" /> {saving ? "Saving…" : "Save schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
