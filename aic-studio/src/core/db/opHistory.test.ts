import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import { startOperation, finishOperation, listOperations } from "./opHistory";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ophist-"));
  db = openDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("op_history", () => {
  it("startOperation inserts a row with status 'running' and returns the row id", () => {
    const id = startOperation(db, {
      envName: "prod",
      opKind: "pull",
      scope: "journeys",
      snapshotDir: "/tmp/snap"
    });
    expect(typeof id).toBe("number");
    const ops = listOperations(db, "prod");
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe(id);
    expect(ops[0].status).toBe("running");
    expect(ops[0].finishedAt).toBeUndefined();
  });

  it("finishOperation sets status + message + finished_at", () => {
    const id = startOperation(db, { envName: "prod", opKind: "pull" });
    finishOperation(db, id, "success", "pulled 12 journeys");
    const ops = listOperations(db, "prod");
    expect(ops[0].status).toBe("success");
    expect(ops[0].message).toBe("pulled 12 journeys");
    expect(typeof ops[0].finishedAt).toBe("number");
  });

  it("listOperations returns most recent first", () => {
    startOperation(db, { envName: "prod", opKind: "pull" });
    startOperation(db, { envName: "prod", opKind: "pull" });
    const ops = listOperations(db, "prod");
    expect(ops).toHaveLength(2);
    expect(ops[0].id).toBeGreaterThan(ops[1].id);
  });

  it("listOperations filters by env name", () => {
    startOperation(db, { envName: "prod", opKind: "pull" });
    startOperation(db, { envName: "stage", opKind: "pull" });
    expect(listOperations(db, "prod")).toHaveLength(1);
    expect(listOperations(db, "stage")).toHaveLength(1);
  });
});

describe("op_history targetEnv", () => {
  it("startOperation accepts targetEnv and round-trips it", () => {
    const id = startOperation(db, { envName: "prod", opKind: "push", targetEnv: "stage" });
    const ops = listOperations(db, "prod");
    expect(ops[0].id).toBe(id);
    expect(ops[0].targetEnv).toBe("stage");
  });

  it("targetEnv is optional", () => {
    startOperation(db, { envName: "prod", opKind: "pull" });
    const ops = listOperations(db, "prod");
    expect(ops[0].targetEnv).toBeUndefined();
  });
});
