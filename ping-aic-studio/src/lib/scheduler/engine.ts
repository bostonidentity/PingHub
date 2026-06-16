import { getSchedule, listSchedules, recordRun } from "@/lib/scheduler/store";
import { runStep } from "@/lib/scheduler/run-step";
import { computeNextRun } from "@/lib/scheduler/cron";
import { NOOP_SINK } from "@/lib/operations/types";
import type { ScheduleRunRef } from "@/lib/scheduler/types";

/** In-memory set of schedule IDs with a run currently in flight. */
const inFlight = new Set<string>();

/** Run one schedule now. Returns the resulting run status (or "skipped-overlap"). */
export async function runSchedule(id: string, now: Date = new Date()): Promise<ScheduleRunRef["status"]> {
  if (inFlight.has(id)) return "skipped-overlap";
  const schedule = getSchedule(id);
  if (!schedule) return "failed";

  inFlight.add(id);
  try {
    let anyFailed = false;
    let stopped = false;
    for (const step of schedule.steps) {
      const result = await runStep(step, id, NOOP_SINK);
      if (result.status === "failed") {
        anyFailed = true;
        if (schedule.onError === "stop") { stopped = true; break; }
      }
    }
    const status: ScheduleRunRef["status"] = !anyFailed ? "success" : stopped ? "failed" : "partial";
    const lastRun: ScheduleRunRef = { at: now.toISOString(), status };
    const nextRunAt = computeNextRun(schedule.trigger, now);
    recordRun(id, lastRun, nextRunAt);
    return status;
  } finally {
    inFlight.delete(id);
  }
}

/** Fire every enabled schedule whose nextRunAt <= now. */
export async function tick(now: Date = new Date()): Promise<void> {
  let schedules;
  try { schedules = listSchedules(); } catch { return; }
  for (const s of schedules) {
    if (!s.enabled) continue;
    if (new Date(s.nextRunAt).getTime() > now.getTime()) continue;
    try { await runSchedule(s.id, now); } catch { /* engine never crashes on one schedule */ }
  }
}

/** Roll past-due schedules with catchUpIfMissed=false forward to their next fire,
 *  recording a skipped marker, so the boot tick doesn't run stale schedules. */
export function rollForwardSkipped(now: Date = new Date()): void {
  let schedules;
  try { schedules = listSchedules(); } catch { return; }
  for (const s of schedules) {
    if (!s.enabled || s.catchUpIfMissed) continue;
    if (new Date(s.nextRunAt).getTime() > now.getTime()) continue;
    try { recordRun(s.id, { at: now.toISOString(), status: "skipped-overlap" }, computeNextRun(s.trigger, now)); }
    catch { /* ignore */ }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 60_000;

/** Start the tick loop. Idempotent. On boot, runs an immediate catch-up tick. */
export function startScheduler(): void {
  if (timer) return;
  rollForwardSkipped();
  void tick().catch(() => {});
  timer = setInterval(() => { void tick().catch(() => {}); }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
