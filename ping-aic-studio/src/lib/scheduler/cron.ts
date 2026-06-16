// src/lib/scheduler/cron.ts
// NOTE: cron-parser v4 (4.9.0) exports `parseExpression`, NOT `CronExpressionParser`.
import { parseExpression } from "cron-parser";
import type { Preset, Trigger } from "@/lib/scheduler/types";

export function presetToCron(p: Preset): string {
  if (p.every === "hour") return `${p.minute} * * * *`;
  const [hh, mm] = p.time.split(":").map((s) => parseInt(s, 10));
  if (p.every === "day") return `${mm} ${hh} * * *`;
  const days = [...p.days].sort((a, b) => a - b).join(",");
  return `${mm} ${hh} * * ${days}`;
}

export function triggerToCron(t: Trigger): string {
  if (t.kind === "cron") {
    if (!t.cron) throw new Error("cron trigger missing cron expression");
    return t.cron;
  }
  if (!t.preset) throw new Error("preset trigger missing preset");
  return presetToCron(t.preset);
}

/** Next fire time strictly after `from`, as an ISO string. Throws on a bad cron. */
export function computeNextRun(t: Trigger, from: Date): string {
  const expr = triggerToCron(t);
  const interval = parseExpression(expr, { currentDate: from, tz: t.timezone });
  return interval.next().toDate().toISOString();
}

/** Validate a trigger; returns an error message or null. */
export function validateTrigger(t: Trigger): string | null {
  try { computeNextRun(t, new Date(0)); return null; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
}
