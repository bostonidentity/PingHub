// src/core/db/promotionTasks.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import {
  createPromotionTask,
  addItemToTask,
  removeItemFromTask,
  listItemsInTask,
  listActiveTasks,
  setTaskStatus,
  getTask
} from "./promotionTasks";
import { deletePromotionTask, listArchivedTasks } from "./promotionTasks";

let db: Database;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "ptasks-")); db = openDatabase(join(tmp, "t.db")); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("promotion_tasks", () => {
  it("createPromotionTask inserts with status 'active' and returns id", () => {
    const id = createPromotionTask(db, { name: "release-1", sourceEnv: "prod" });
    expect(typeof id).toBe("number");
    const t = getTask(db, id);
    expect(t?.name).toBe("release-1");
    expect(t?.status).toBe("active");
    expect(t?.sourceEnv).toBe("prod");
  });

  it("addItemToTask is idempotent (PK prevents duplicates)", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    expect(listItemsInTask(db, id)).toHaveLength(1);
  });

  it("removeItemFromTask drops the row", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    removeItemFromTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    expect(listItemsInTask(db, id)).toHaveLength(0);
  });

  it("listActiveTasks returns only 'active' tasks ordered by updated_at DESC", () => {
    const a = createPromotionTask(db, { name: "a", sourceEnv: "prod" });
    const b = createPromotionTask(db, { name: "b", sourceEnv: "prod" });
    setTaskStatus(db, a, "archived");
    const active = listActiveTasks(db);
    expect(active.map((t) => t.id)).toEqual([b]);
  });

  it("setTaskStatus to 'archived' removes from active list", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    expect(listActiveTasks(db)).toHaveLength(1);
    setTaskStatus(db, id, "archived");
    expect(listActiveTasks(db)).toHaveLength(0);
  });
});

describe("promotion_tasks deletion + archived listing", () => {
  it("deletePromotionTask removes task + cascades item rows", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    deletePromotionTask(db, id);
    expect(getTask(db, id)).toBeUndefined();
    expect(listItemsInTask(db, id)).toHaveLength(0);
  });

  it("listArchivedTasks returns only 'archived' tasks", () => {
    const _a = createPromotionTask(db, { name: "active", sourceEnv: "prod" });
    void _a;
    const b = createPromotionTask(db, { name: "archived", sourceEnv: "prod" });
    setTaskStatus(db, b, "archived");
    expect(listArchivedTasks(db).map((t) => t.id)).toEqual([b]);
  });
});
