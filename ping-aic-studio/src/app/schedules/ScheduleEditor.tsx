"use client";
import { useMemo, useState } from "react";
import type { ScheduleInput, Step, SyncStep, PullDataStep, Trigger } from "@/lib/scheduler/types";
import type { Environment, ConfigScope } from "@/lib/fr-config";
import { CONFIG_SCOPES } from "@/lib/fr-config-types";

export function ScheduleEditor({ initial, environments = [], typesByEnv = {}, onClose, onSaved }: {
  initial?: ScheduleInput & { id?: string };
  environments?: Environment[];
  typesByEnv?: Record<string, string[]>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [trigger, setTrigger] = useState<Trigger>(initial?.trigger ?? { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [onError, setOnError] = useState<"stop" | "continue">(initial?.onError ?? "stop");
  const [catchUpIfMissed, setCatchUp] = useState(initial?.catchUpIfMissed ?? true);
  const [steps, setSteps] = useState<Step[]>(initial?.steps ?? [{ type: "git-push" }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // CLI-runnable scopes grouped for the sync-step scope picker.
  const scopeGroups = useMemo(() => {
    const groups: Record<string, { value: ConfigScope; label: string }[]> = {};
    for (const s of CONFIG_SCOPES) {
      if (s.cliSupported === false) continue;
      (groups[s.group] ??= []).push({ value: s.value as ConfigScope, label: s.label });
    }
    return groups;
  }, []);

  const updateStep = (i: number, next: Step) => setSteps(steps.map((x, j) => (j === i ? next : x)));

  const toggleScope = (i: number, step: SyncStep, value: ConfigScope) => {
    const has = step.scopes.includes(value);
    updateStep(i, { ...step, scopes: has ? step.scopes.filter((v) => v !== value) : [...step.scopes, value] });
  };

  const toggleManagedObject = (i: number, step: PullDataStep, value: string) => {
    const has = step.managedObjects.includes(value);
    updateStep(i, { ...step, managedObjects: has ? step.managedObjects.filter((v) => v !== value) : [...step.managedObjects, value] });
  };

  const save = async () => {
    setSaving(true); setErr(null);
    const payload: ScheduleInput = { name, enabled, trigger, onError, catchUpIfMissed, steps };
    const url = initial?.id ? `/api/schedules/${initial.id}` : "/api/schedules";
    const method = initial?.id ? "PUT" : "POST";
    const res = await fetch(url, { method, body: JSON.stringify(payload) });
    setSaving(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return; }
    onSaved(); onClose();
  };

  return (
    <div className="space-y-3">
      <label className="block">Name
        <input className="block w-full rounded border p-2" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>

      <fieldset className="rounded border p-3">
        <legend className="text-sm">Trigger</legend>
        <label className="flex items-center gap-2"><input type="radio" checked={trigger.kind === "preset"} onChange={() => setTrigger({ kind: "preset", preset: { every: "day", time: "02:00" }, timezone: trigger.timezone })} /> Preset</label>
        <label className="flex items-center gap-2"><input type="radio" checked={trigger.kind === "cron"} onChange={() => setTrigger({ kind: "cron", cron: "0 2 * * *", timezone: trigger.timezone })} /> Advanced (cron)</label>
        {trigger.kind === "cron" && (
          <input aria-label="cron" className="mt-2 block w-full rounded border p-2 font-mono" value={trigger.cron ?? ""} onChange={(e) => setTrigger({ ...trigger, cron: e.target.value })} />
        )}
        {trigger.kind === "preset" && (
          <input aria-label="daily time" type="time" className="mt-2 rounded border p-2" value={trigger.preset?.every === "day" ? trigger.preset.time : "02:00"} onChange={(e) => setTrigger({ kind: "preset", preset: { every: "day", time: e.target.value }, timezone: trigger.timezone })} />
        )}
      </fieldset>

      <fieldset className="rounded border p-3">
        <legend className="text-sm">Steps</legend>
        {steps.map((s, i) => (
          <div key={i} className="mb-3 rounded border p-3">
            <div className="flex items-center gap-2">
              <select aria-label={`step-${i}-type`} className="rounded border p-1.5" value={s.type} onChange={(e) => {
                const type = e.target.value as Step["type"];
                const next: Step = type === "sync" ? { type, environment: "", scopes: [] } : type === "pull-data" ? { type, environment: "", managedObjects: [] } : { type: "git-push" };
                updateStep(i, next);
              }}>
                <option value="sync">Sync (config pull)</option>
                <option value="pull-data">Pull data</option>
                <option value="git-push">Commit &amp; push</option>
              </select>
              <button type="button" className="ml-auto text-sm text-red-600" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button>
            </div>

            {s.type === "sync" && (
              <div className="mt-2 space-y-2">
                <label className="block text-sm">Environment
                  <select aria-label={`step-${i}-environment`} className="mt-1 block w-full rounded border p-1.5" value={s.environment} onChange={(e) => updateStep(i, { ...s, environment: e.target.value })}>
                    <option value="">Select an environment…</option>
                    {environments.map((env) => <option key={env.name} value={env.name}>{env.label}</option>)}
                  </select>
                </label>
                <div className="text-sm">
                  Scopes <span className="text-muted-foreground">({s.scopes.length ? `${s.scopes.length} selected` : "all scopes"})</span>
                  <div className="mt-1 max-h-48 space-y-2 overflow-auto rounded border p-2">
                    {Object.entries(scopeGroups).map(([group, scopes]) => (
                      <div key={group}>
                        <div className="text-xs font-medium text-muted-foreground">{group}</div>
                        {scopes.map((sc) => (
                          <label key={sc.value} className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={s.scopes.includes(sc.value)} onChange={() => toggleScope(i, s, sc.value)} /> {sc.label}
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {s.type === "pull-data" && (
              <div className="mt-2 space-y-2">
                <label className="block text-sm">Environment
                  <select aria-label={`step-${i}-environment`} className="mt-1 block w-full rounded border p-1.5" value={s.environment} onChange={(e) => updateStep(i, { ...s, environment: e.target.value, managedObjects: [] })}>
                    <option value="">Select an environment…</option>
                    {environments.map((env) => <option key={env.name} value={env.name}>{env.label}</option>)}
                  </select>
                </label>
                <div className="text-sm">
                  Managed objects <span className="text-muted-foreground">({s.managedObjects.length} selected)</span>
                  {!s.environment ? (
                    <p className="mt-1 text-xs text-muted-foreground">Select an environment to choose managed objects.</p>
                  ) : (typesByEnv[s.environment] ?? []).length === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">No managed objects found for this environment.</p>
                  ) : (
                    <div className="mt-1 max-h-48 space-y-1 overflow-auto rounded border p-2">
                      {(typesByEnv[s.environment] ?? []).map((mo) => (
                        <label key={mo} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={s.managedObjects.includes(mo)} onChange={() => toggleManagedObject(i, s, mo)} /> {mo}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {s.type === "git-push" && (
              <label className="mt-2 block text-sm">Commit message <span className="text-muted-foreground">(optional)</span>
                <input aria-label={`step-${i}-message`} className="mt-1 block w-full rounded border p-1.5" value={s.message ?? ""} onChange={(e) => updateStep(i, { ...s, message: e.target.value || undefined })} />
              </label>
            )}
          </div>
        ))}
        <button type="button" className="text-sm underline" onClick={() => setSteps([...steps, { type: "git-push" }])}>Add step</button>
      </fieldset>

      <label className="block">On step failure
        <select className="block rounded border p-2" value={onError} onChange={(e) => setOnError(e.target.value as "stop" | "continue")}>
          <option value="stop">Stop pipeline</option>
          <option value="continue">Continue</option>
        </select>
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={catchUpIfMissed} onChange={(e) => setCatchUp(e.target.checked)} /> Run once on startup if missed</label>

      {err && <div className="text-red-600">{err}</div>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving} className="rounded bg-blue-600 px-4 py-2 text-white">Save</button>
        <button onClick={onClose} className="rounded border px-4 py-2">Cancel</button>
      </div>
    </div>
  );
}
