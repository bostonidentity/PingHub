import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { ScopeSelection } from "./fr-config-types";

const ENVIRONMENTS_DIR = path.join(process.cwd(), "environments");
const TASKS_PATH = path.join(ENVIRONMENTS_DIR, "promotion-tasks.json");

export type TaskStatus = "new" | "in-progress" | "completed" | "failed";

export interface TaskEndpoint {
  environment: string;
  mode: "local" | "remote";
}

export interface PromotionTask {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  source: TaskEndpoint;
  target: TaskEndpoint;
  items: ScopeSelection[];
  includeDeps?: boolean;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp when the task was archived. Present only on archived tasks. */
  archivedAt?: string;
  /** ISO timestamp when Step 2 Promote actually started. */
  promotedAt?: string;
  /** ISO timestamp when verify finished (promotion fully complete). */
  completedAt?: string;
  /** ID of the saved dry-run report (matches promotion-reports/{reportId}.json). */
  reportId?: string;
  /** Phase outcomes from the promotion execution. */
  phaseOutcomes?: Record<string, string>;
  /** Phase timings from the promotion execution. */
  phaseTimings?: Record<string, { status: string; startedAt?: string; completedAt?: string; durationMs?: number }>;
  /** Verify report summary (changes remaining after promote). */
  verifyChanges?: number;
  /** Stderr/error log lines captured during a failed promote, shown in the summary. */
  errorLogs?: { type: "stderr" | "error"; data: string }[];
  /** Full stdout/stderr/error log from a failed promote run, shown collapsibly in the summary. */
  promoteLogs?: { type: "stdout" | "stderr" | "error"; data: string }[];
}

export function readTasks(): PromotionTask[] {
  if (!fs.existsSync(TASKS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(TASKS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

/** Active tasks (not archived). Auto-archives completed tasks on read; failed tasks stay active. */
export function readActiveTasks(): PromotionTask[] {
  const all = readTasks();
  let changed = false;
  const now = new Date().toISOString();
  for (const t of all) {
    if (!t.archivedAt && t.status === "completed") {
      t.archivedAt = now;
      changed = true;
    }
  }
  if (changed) saveTasks(all);
  return all.filter((t) => !t.archivedAt);
}

/** Archived tasks, most recently archived first. */
export function readArchivedTasks(): PromotionTask[] {
  return readTasks()
    .filter((t) => !!t.archivedAt)
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
}

function saveTasks(tasks: PromotionTask[]): void {
  if (!fs.existsSync(ENVIRONMENTS_DIR)) {
    fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
  }
  fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2));
}

export function createTask(
  data: Omit<PromotionTask, "id" | "createdAt" | "updatedAt">
): PromotionTask {
  const now = new Date().toISOString();
  const task: PromotionTask = { id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now };
  const tasks = readTasks();
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

export function updateTask(
  id: string,
  patch: Partial<Omit<PromotionTask, "id" | "createdAt">> & { archivedAt?: string | null },
): PromotionTask | null {
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const merged = { ...tasks[idx], ...patch, updatedAt: new Date().toISOString() };
  if (patch.archivedAt === null) delete merged.archivedAt;
  tasks[idx] = merged as PromotionTask;
  saveTasks(tasks);
  return tasks[idx];
}

export function deleteTask(id: string): boolean {
  const tasks = readTasks();
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) return false;
  saveTasks(filtered);
  return true;
}
