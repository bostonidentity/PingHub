// src/core/db/savedLogQueries.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import {
  saveQuery, listSavedQueries, getSavedQuery, updateLastRun, deleteSavedQuery
} from "./savedLogQueries";

let db: Database;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "slq-")); db = openDatabase(join(tmp, "t.db")); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("saved_log_queries", () => {
  it("saveQuery returns id; listSavedQueries returns it", () => {
    const id = saveQuery(db, { envName: "prod", name: "errors", source: "am-everything", filterExpr: `eventName eq "AM-LOGIN-FAILED"` });
    expect(typeof id).toBe("number");
    const all = listSavedQueries(db, "prod");
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("errors");
    expect(all[0].source).toBe("am-everything");
  });

  it("filterExpr is optional", () => {
    const id = saveQuery(db, { envName: "prod", name: "all", source: "am-everything" });
    const q = getSavedQuery(db, id);
    expect(q?.filterExpr).toBeUndefined();
  });

  it("listSavedQueries filters by env", () => {
    saveQuery(db, { envName: "prod", name: "p", source: "am" });
    saveQuery(db, { envName: "stage", name: "s", source: "am" });
    expect(listSavedQueries(db, "prod")).toHaveLength(1);
    expect(listSavedQueries(db, "stage")).toHaveLength(1);
  });

  it("updateLastRun sets last_run_at", () => {
    const id = saveQuery(db, { envName: "prod", name: "x", source: "am" });
    expect(getSavedQuery(db, id)?.lastRunAt).toBeUndefined();
    updateLastRun(db, id);
    expect(getSavedQuery(db, id)?.lastRunAt).toBeGreaterThan(0);
  });

  it("deleteSavedQuery removes the row", () => {
    const id = saveQuery(db, { envName: "prod", name: "x", source: "am" });
    deleteSavedQuery(db, id);
    expect(getSavedQuery(db, id)).toBeUndefined();
  });
});
