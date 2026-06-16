"use client";
import { useState } from "react";
import type { ScheduleInput, Step, Trigger } from "@/lib/scheduler/types";

export function ScheduleEditor({ initial, onClose, onSaved }: {
  initial?: ScheduleInput & { id?: string };
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
          <div key={i} className="mb-2 flex items-center gap-2">
            <select aria-label={`step-${i}-type`} value={s.type} onChange={(e) => {
              const type = e.target.value as Step["type"];
              const next: Step = type === "sync" ? { type, environment: "", scopes: [] } : type === "pull-data" ? { type, environment: "", managedObjects: [] } : { type: "git-push" };
              setSteps(steps.map((x, j) => (j === i ? next : x)));
            }}>
              <option value="sync">Sync (config pull)</option>
              <option value="pull-data">Pull data</option>
              <option value="git-push">Commit &amp; push</option>
            </select>
            <button type="button" className="text-red-600" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button>
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
