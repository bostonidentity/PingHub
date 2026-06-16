"use client";
import { useEffect, useState, useCallback } from "react";
import type { Schedule } from "@/lib/scheduler/types";

function triggerSummary(s: Schedule): string {
  const t = s.trigger;
  if (t.kind === "cron") return `cron: ${t.cron}`;
  const p = t.preset!;
  if (p.every === "hour") return `Hourly at :${String(p.minute).padStart(2, "0")}`;
  if (p.every === "day") return `Daily ${p.time}`;
  return `Weekly [${p.days.join(",")}] ${p.time}`;
}

export function ScheduleList() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSchedules(await res.json());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const runNow = async (id: string) => { await fetch(`/api/schedules/${id}/run`, { method: "POST" }); void reload(); };
  const toggle = async (s: Schedule) => { await fetch(`/api/schedules/${s.id}`, { method: "PUT", body: JSON.stringify({ enabled: !s.enabled }) }); void reload(); };
  const remove = async (id: string) => { await fetch(`/api/schedules/${id}`, { method: "DELETE" }); void reload(); };

  if (error) return <div className="p-4 text-red-600">Failed to load schedules: {error}</div>;

  return (
    <div className="space-y-2">
      {schedules.length === 0 && <p className="text-muted-foreground">No schedules yet.</p>}
      {schedules.map((s) => (
        <div key={s.id} className="flex items-center justify-between rounded border p-3">
          <div>
            <div className="font-medium">{s.name}</div>
            <div className="text-sm text-muted-foreground">
              {triggerSummary(s)} · next {new Date(s.nextRunAt).toLocaleString()}
              {s.lastRun && <> · last <span className={s.lastRun.status === "success" ? "text-green-600" : s.lastRun.status === "failed" ? "text-red-600" : "text-yellow-600"}>{s.lastRun.status}</span></>}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => toggle(s)} className="text-sm underline">{s.enabled ? "Disable" : "Enable"}</button>
            <button onClick={() => runNow(s.id)} className="text-sm underline">Run now</button>
            <button onClick={() => remove(s.id)} className="text-sm text-red-600 underline">Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
