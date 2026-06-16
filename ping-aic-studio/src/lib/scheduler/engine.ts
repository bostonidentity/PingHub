import { getSchedule, listSchedules, recordRun } from "@/lib/scheduler/store";
import { runStep } from "@/lib/scheduler/run-step";
import { computeNextRun } from "@/lib/scheduler/cron";
import { startLog, appendLog, endLog } from "@/lib/scheduler/log-buffer";
import type { OpEventSink } from "@/lib/operations/types";
import type { ScheduleRunRef, Step } from "@/lib/scheduler/types";

/** Pause/resume/stop control for an in-flight run, keyed by schedule id. */
interface RunControl { paused: boolean; stopRequested: boolean; wake: () => void; }

/**
 * Process-wide scheduler state.
 *
 * In Next.js the scheduler (started from `instrumentation.ts`) and the API route
 * handlers can evaluate this module as SEPARATE instances within the same Node
 * process. Module-local singletons would therefore NOT be shared: a timer-fired
 * run populates the scheduler instance's state, but the API reads the route
 * instance's — so the run shows no "running" indicator, an empty live log, and
 * pause/stop become no-ops. Anchoring on globalThis (one per process) shares the
 * state across instances and also survives dev HMR module reloads.
 */
interface SchedulerState {
  inFlight: Set<string>;
  controls: Map<string, RunControl>;
  timer: ReturnType<typeof setInterval> | null;
}
const g = globalThis as unknown as { __pinghubScheduler?: SchedulerState };
const state: SchedulerState = (g.__pinghubScheduler ??= { inFlight: new Set(), controls: new Map(), timer: null });
const inFlight = state.inFlight;
const controls = state.controls;

export function pauseSchedule(id: string): void { const c = controls.get(id); if (c) c.paused = true; }
export function resumeSchedule(id: string): void { const c = controls.get(id); if (c) { c.paused = false; c.wake(); } }
export function stopSchedule(id: string): void { const c = controls.get(id); if (c) { c.stopRequested = true; c.paused = false; c.wake(); } }
export function isPaused(id: string): boolean { return controls.get(id)?.paused ?? false; }

/** Human-readable header for a step in the live log. */
function stepLabel(step: Step): string {
  if (step.type === "sync") return `Sync [${step.environments.join(", ") || "—"}]`;
  if (step.type === "pull-data") return `Pull data [${step.environments.join(", ") || "—"}]`;
  return "Commit & push";
}

/** Run one schedule now. Returns the resulting run status (or "skipped-overlap"). */
export async function runSchedule(id: string, now: Date = new Date()): Promise<ScheduleRunRef["status"]> {
  if (inFlight.has(id)) return "skipped-overlap";
  const schedule = getSchedule(id);
  if (!schedule) return "failed";

  inFlight.add(id);
  startLog(id);
  const control: RunControl = { paused: false, stopRequested: false, wake: () => {} };
  controls.set(id, control);
  const sink: OpEventSink = (evt) => appendLog(id, evt);
  try {
    let anyFailed = false;
    let anySucceeded = false;
    let stopped = false;       // halted early by an onError=stop failing step
    let stopRequested = false; // halted early by an explicit stop request
    let totalMs = 0;
    let okCount = 0;
    for (const [i, step] of schedule.steps.entries()) {
      if (control.stopRequested) { stopRequested = true; break; }
      // Pause gate: wait at the step boundary until resumed or stopped.
      let wasPaused = false;
      while (control.paused && !control.stopRequested) {
        wasPaused = true;
        appendLog(id, { type: "stdout", data: "⏸ Paused — waiting to resume…" });
        await new Promise<void>((res) => { control.wake = res; });
      }
      if (control.stopRequested) { stopRequested = true; break; }
      if (wasPaused) appendLog(id, { type: "stdout", data: "▶ Resumed" });

      appendLog(id, { type: "stdout", data: `▶ Step ${i + 1}/${schedule.steps.length}: ${stepLabel(step)}` });
      const result = await runStep(step, id, sink);
      totalMs += result.durationMs ?? 0;
      if (result.status === "failed") {
        anyFailed = true;
        if (schedule.onError === "stop") { stopped = true; break; }
      } else {
        anySucceeded = true;
        okCount++;
      }
    }
    const status: ScheduleRunRef["status"] = stopRequested
      ? "stopped"
      : !anyFailed ? "success" : (stopped || !anySucceeded) ? "failed" : "partial";
    if (stopRequested) appendLog(id, { type: "stdout", data: "■ Stopped" });
    const summary = `${okCount}/${schedule.steps.length} steps ok`;
    const lastRun: ScheduleRunRef = { at: now.toISOString(), status, durationMs: totalMs, summary };
    const nextRunAt = computeNextRun(schedule.trigger, now);
    endLog(id, status === "success" ? 0 : 1);
    recordRun(id, lastRun, nextRunAt);
    return status;
  } finally {
    inFlight.delete(id);
    controls.delete(id);
  }
}

/** Fire every enabled schedule whose nextRunAt <= now. */
export async function tick(now: Date = new Date()): Promise<void> {
  let schedules;
  try { schedules = listSchedules(); } catch { return; }
  for (const s of schedules) {
    if (!s.enabled) continue;
    if (new Date(s.nextRunAt).getTime() > now.getTime()) continue;
    try { void runSchedule(s.id, now).catch(() => {}); } catch { /* engine never crashes on one schedule */ }
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

// Poll frequently so a due schedule starts within a few seconds of its scheduled
// minute. Cron is minute-resolution, and recordRun advances nextRunAt immediately
// (with the in-flight lock preventing re-fire), so a short interval can't double-fire.
const TICK_MS = 5_000;

/** Start the tick loop. Idempotent (process-wide). On boot, runs an immediate catch-up tick. */
export function startScheduler(): void {
  if (state.timer) return;
  rollForwardSkipped();
  void tick().catch(() => {});
  state.timer = setInterval(() => { void tick().catch(() => {}); }, TICK_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

export function stopScheduler(): void {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

export function isRunning(id: string): boolean { return inFlight.has(id); }
export function runningIds(): string[] { return [...inFlight]; }
