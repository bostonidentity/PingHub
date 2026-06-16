import { getSchedule, recordRun } from "@/lib/scheduler/store";
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
