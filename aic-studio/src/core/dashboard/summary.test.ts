// src/core/dashboard/summary.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../db/connection";
import { insertEnvironment } from "../db/environments";
import { startOperation, finishOperation } from "../db/opHistory";
import { recordAlert } from "../db/monitorChecks";
import { buildDashboardSummary } from "./summary";

let db: Database;
let storage: string;

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "dashboard-"));
  db = openDatabase(join(storage, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(storage, { recursive: true, force: true });
});

describe("buildDashboardSummary", () => {
  it("returns empty summary when no envs", () => {
    const r = buildDashboardSummary(db, storage);
    expect(r.envs).toEqual([]);
    expect(r.totalRecentOps).toBe(0);
    expect(r.totalAlerts).toBe(0);
  });

  it("includes env summary with op counts", () => {
    insertEnvironment(db, {
      name: "prod", label: "Production",
      tenantUrl: "https://prod.id.forgerock.io",
      username: "svc", clientId: "client", color: "blue"
    });
    const opId = startOperation(db, { envName: "prod", opKind: "pull" });
    finishOperation(db, opId, "success", "ok");

    const r = buildDashboardSummary(db, storage);
    expect(r.envs).toHaveLength(1);
    expect(r.envs[0].envName).toBe("prod");
    expect(r.envs[0].envLabel).toBe("Production");
    expect(r.envs[0].recentOpCount).toBe(1);
    expect(r.totalRecentOps).toBe(1);
  });

  it("records last pull timestamp", () => {
    insertEnvironment(db, {
      name: "prod", label: "P",
      tenantUrl: "https://x", username: "u", clientId: "c", color: "blue"
    });
    const id = startOperation(db, { envName: "prod", opKind: "pull" });
    finishOperation(db, id, "success");

    const r = buildDashboardSummary(db, storage);
    expect(r.envs[0].lastPullAt).toBeGreaterThan(0);
  });

  it("counts snapshots from disk", () => {
    insertEnvironment(db, {
      name: "prod", label: "P",
      tenantUrl: "https://x", username: "u", clientId: "c", color: "blue"
    });
    const snapDir = join(storage, "snapshots", "prod");
    mkdirSync(join(snapDir, "2026-05-24T10-00-00Z"), { recursive: true });
    mkdirSync(join(snapDir, "2026-05-24T11-00-00Z"), { recursive: true });

    const r = buildDashboardSummary(db, storage);
    expect(r.envs[0].snapshotCount).toBe(2);
  });

  it("counts active monitor alerts", () => {
    insertEnvironment(db, {
      name: "prod", label: "P",
      tenantUrl: "https://x", username: "u", clientId: "c", color: "blue"
    });
    recordAlert(db, { envName: "prod", checkType: "tls", severity: "warning", message: "expiring" });
    recordAlert(db, { envName: "prod", checkType: "ping", severity: "error", message: "down" });

    const r = buildDashboardSummary(db, storage);
    expect(r.envs[0].hasMonitorAlerts).toBe(true);
    expect(r.totalAlerts).toBe(2);
  });
});
