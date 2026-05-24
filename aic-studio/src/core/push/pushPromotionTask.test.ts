// src/core/push/pushPromotionTask.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushPromotionTask } from "./pushPromotionTask";
import type { TaskItem } from "../db/promotionTasks";

let storage: string;

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "pushpt-"));
  nock.disableNetConnect();
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

function seed(envName: string, stamp: string, realm: string, id: string, body: unknown) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("pushPromotionTask", () => {
  it("pushes every journey item to target env and reports per-item results", async () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", "Login", { _id: "Login" });
    seed("prod", "2026-05-24T15-30-00Z", "alpha", "Register", { _id: "Register" });

    nock("https://stage.id.forgerock.io")
      .put(/authenticationtrees\/Login$/).reply(200, { _id: "Login", _rev: "1" })
      .put(/authenticationtrees\/Register$/).reply(200, { _id: "Register", _rev: "1" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const items: TaskItem[] = [
      { realm: "alpha", resourceType: "journey", resourceId: "Login" },
      { realm: "alpha", resourceType: "journey", resourceId: "Register" }
    ];
    const summary = await pushPromotionTask({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      items
    });
    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(0);
  });

  it("continues on per-item failure and reports them all", async () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", "Login", { _id: "Login" });

    nock("https://stage.id.forgerock.io")
      .put(/authenticationtrees\/Login$/).reply(500, { error: "boom" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const items: TaskItem[] = [
      { realm: "alpha", resourceType: "journey", resourceId: "Login" }
    ];
    const summary = await pushPromotionTask({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      items
    });
    expect(summary.successCount).toBe(0);
    expect(summary.failureCount).toBe(1);
    expect(summary.failures[0].error).toMatch(/500/);
  });

  it("skips non-journey resource types in M3 (returns them as 'skipped')", async () => {
    const cache = { get: async () => "t", invalidate: () => {} };
    const items: TaskItem[] = [
      { realm: "alpha", resourceType: "script", resourceId: "S1" }
    ];
    const summary = await pushPromotionTask({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      items
    });
    expect(summary.skippedCount).toBe(1);
  });

  it("routes federation items through pushFederationFromSnapshot", async () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login" });
    // Also seed federation
    const fedDir = join(storage, "snapshots", "prod", "2026-05-24T10-00-00Z", "alpha", "federation", "saml2");
    mkdirSync(fedDir, { recursive: true });
    writeFileSync(join(fedDir, "sp.json"), JSON.stringify({ _id: "sp" }));
    nock("https://stage.id.forgerock.io")
      .put(/authenticationtrees\/Login$/).reply(200, { _id: "Login" })
      .put(/saml2\/sp$/).reply(200, { _id: "sp" });
    const cache = { get: async () => "t", invalidate: () => {} };
    const summary = await pushPromotionTask({
      globalStoragePath: storage, sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
      items: [
        { realm: "alpha", resourceType: "journey", resourceId: "Login" },
        { realm: "alpha", resourceType: "federation/saml2", resourceId: "sp" }
      ]
    });
    expect(summary.successCount).toBe(2);
    expect(summary.skippedCount).toBe(0);
  });
});
