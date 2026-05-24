// src/core/db/promotionTasks.ts
import type { Database } from "better-sqlite3";

export type TaskStatus = "active" | "archived";

export interface PromotionTaskRow {
  id: number;
  name: string;
  sourceEnv: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskItem {
  realm: string;
  resourceType: string;
  resourceId: string;
}

interface RawTaskRow {
  id: number;
  name: string;
  source_env: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function rowToTask(r: RawTaskRow): PromotionTaskRow {
  return {
    id: r.id,
    name: r.name,
    sourceEnv: r.source_env,
    status: r.status as TaskStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export function createPromotionTask(db: Database, input: { name: string; sourceEnv: string }): number {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO promotion_tasks (name, source_env, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `).run(input.name, input.sourceEnv, now, now);
  return Number(info.lastInsertRowid);
}

export function getTask(db: Database, id: number): PromotionTaskRow | undefined {
  const row = db.prepare("SELECT * FROM promotion_tasks WHERE id = ?").get(id) as RawTaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function listActiveTasks(db: Database): PromotionTaskRow[] {
  const rows = db.prepare(`
    SELECT * FROM promotion_tasks WHERE status = 'active' ORDER BY updated_at DESC
  `).all() as RawTaskRow[];
  return rows.map(rowToTask);
}

export function setTaskStatus(db: Database, id: number, status: TaskStatus): void {
  db.prepare("UPDATE promotion_tasks SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
}

export function addItemToTask(db: Database, taskId: number, item: TaskItem): void {
  db.prepare(`
    INSERT OR IGNORE INTO promotion_task_items (task_id, realm, resource_type, resource_id)
    VALUES (?, ?, ?, ?)
  `).run(taskId, item.realm, item.resourceType, item.resourceId);
  db.prepare("UPDATE promotion_tasks SET updated_at = ? WHERE id = ?").run(Date.now(), taskId);
}

export function removeItemFromTask(db: Database, taskId: number, item: TaskItem): void {
  db.prepare(`
    DELETE FROM promotion_task_items
    WHERE task_id = ? AND realm = ? AND resource_type = ? AND resource_id = ?
  `).run(taskId, item.realm, item.resourceType, item.resourceId);
}

export function listItemsInTask(db: Database, taskId: number): TaskItem[] {
  const rows = db.prepare(`
    SELECT realm, resource_type AS resourceType, resource_id AS resourceId
    FROM promotion_task_items WHERE task_id = ?
    ORDER BY realm, resource_type, resource_id
  `).all(taskId) as TaskItem[];
  return rows;
}
