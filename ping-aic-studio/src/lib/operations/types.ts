// src/lib/operations/types.ts

/** A single JSONL event emitted during an operation (same shape the routes stream). */
export type OpEvent = Record<string, unknown> & { type: string; ts?: number };

/** Callback the cores use to emit progress. Routes enqueue to a stream; the
 *  scheduler ignores or buffers. Must never throw back into the core. */
export type OpEventSink = (evt: OpEvent) => void;

/** No-op sink for callers that don't consume events (e.g. the scheduler). */
export const NOOP_SINK: OpEventSink = () => {};

/** Result of running one operation core. */
export interface OpResult {
  status: "success" | "failed";
  /** op-log entry id, when one was written. */
  runId?: string;
  summary: string;
  durationMs: number;
  /** Populated when status === "failed". */
  error?: string;
}
