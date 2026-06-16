import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { computeNextRun } from "@/lib/scheduler/cron";
import type { Schedule, ScheduleInput, ScheduleRunRef } from "@/lib/scheduler/types";

const FILE = path.join(ENVIRONMENTS_DIR, "schedules.json");

function readAll(): Schedule[] {
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.schedules) ? parsed.schedules : [];
  } catch { return []; }
}

function writeAll(schedules: Schedule[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schedules }, null, 2), "utf-8");
  fs.renameSync(tmp, FILE);
}

export function listSchedules(): Schedule[] { return readAll(); }
export function getSchedule(id: string): Schedule | null { return readAll().find((s) => s.id === id) ?? null; }

export function createSchedule(input: ScheduleInput, now: Date = new Date()): Schedule {
  const iso = now.toISOString();
  const schedule: Schedule = {
    id: randomUUID(),
    ...input,
    nextRunAt: computeNextRun(input.trigger, now),
    createdAt: iso,
    updatedAt: iso,
  };
  const all = readAll();
  all.push(schedule);
  writeAll(all);
  return schedule;
}

export function updateSchedule(id: string, patch: Partial<ScheduleInput>, now: Date = new Date()): Schedule | null {
  const all = readAll();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const merged: Schedule = { ...all[idx], ...patch, updatedAt: now.toISOString() };
  if (patch.trigger) merged.nextRunAt = computeNextRun(merged.trigger, now);
  all[idx] = merged;
  writeAll(all);
  return merged;
}

/** Persist run outcome + the next fire time. Used by the engine. */
export function recordRun(id: string, lastRun: ScheduleRunRef, nextRunAt: string): void {
  const all = readAll();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return;
  all[idx] = { ...all[idx], lastRun, nextRunAt };
  writeAll(all);
}

export function deleteSchedule(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}
