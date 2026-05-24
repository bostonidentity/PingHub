// src/core/db/monitorChecks.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import {
  recordCheck, latestCheck, listChecks,
  recordAlert, acknowledgeAlert, listActiveAlerts
} from "./monitorChecks";

let db: Database;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "mc-")); db = openDatabase(join(tmp, "t.db")); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("monitor_checks", () => {
  it("recordCheck inserts a row and latestCheck returns it", () => {
    recordCheck(db, { envName: "prod", checkType: "tls", status: "ok", detail: "cert valid", daysRemaining: 89 });
    const latest = latestCheck(db, "prod", "tls");
    expect(latest?.status).toBe("ok");
    expect(latest?.daysRemaining).toBe(89);
  });

  it("latestCheck returns the most recent of multiple", () => {
    recordCheck(db, { envName: "prod", checkType: "tls", status: "ok" });
    recordCheck(db, { envName: "prod", checkType: "tls", status: "warning", detail: "expiring soon" });
    const latest = latestCheck(db, "prod", "tls");
    expect(latest?.status).toBe("warning");
  });

  it("listChecks returns rows newest-first up to limit", () => {
    for (let i = 0; i < 5; i++) recordCheck(db, { envName: "prod", checkType: "ping", status: "ok" });
    const rows = listChecks(db, "prod", "ping", 3);
    expect(rows).toHaveLength(3);
  });
});

describe("monitor_alerts", () => {
  it("recordAlert + listActiveAlerts round-trip", () => {
    recordAlert(db, { envName: "prod", checkType: "tls", severity: "warning", message: "expires in 17d" });
    const alerts = listActiveAlerts(db, "prod");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe("expires in 17d");
  });

  it("acknowledgeAlert removes from active list", () => {
    recordAlert(db, { envName: "prod", checkType: "tls", severity: "warning", message: "x" });
    const id = listActiveAlerts(db, "prod")[0].id;
    acknowledgeAlert(db, id);
    expect(listActiveAlerts(db, "prod")).toHaveLength(0);
  });
});
