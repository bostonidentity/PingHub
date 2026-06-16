import type { OpEvent } from "@/lib/operations/types";

interface Buf { events: OpEvent[]; running: boolean; exitCode: number | null; }

// Anchored on globalThis so the scheduler instance (started from instrumentation)
// and the API route handlers — which Next.js may load as separate module
// instances in the same process — share one buffer. See engine.ts for the full
// rationale. Without this, a timer-fired run's live log is invisible to the API.
const g = globalThis as unknown as { __pinghubLogBuffers?: Map<string, Buf> };
const buffers: Map<string, Buf> = (g.__pinghubLogBuffers ??= new Map());
const MAX = 2000;

/** Begin (or reset) the live log for a schedule run. */
export function startLog(id: string): void { buffers.set(id, { events: [], running: true, exitCode: null }); }

/** Append one event to the running buffer (no-op if none active). */
export function appendLog(id: string, evt: OpEvent): void {
  const b = buffers.get(id);
  if (!b) return;
  b.events.push(evt);
  if (b.events.length > MAX) b.events.splice(0, b.events.length - MAX);
}

/** Mark the run finished with its exit code. */
export function endLog(id: string, exitCode: number): void {
  const b = buffers.get(id);
  if (b) { b.running = false; b.exitCode = exitCode; }
}

/** Read events after `since` (cursor index). Returns null if no buffer exists. */
export function getLog(id: string, since = 0): { running: boolean; exitCode: number | null; events: OpEvent[]; cursor: number } | null {
  const b = buffers.get(id);
  if (!b) return null;
  return { running: b.running, exitCode: b.exitCode, events: b.events.slice(since), cursor: b.events.length };
}
