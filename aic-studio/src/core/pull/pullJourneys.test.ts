// src/core/pull/pullJourneys.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullAllJourneys } from "./pullJourneys";
import { latestSnapshotDir, journeyFile } from "../snapshots/paths";

let storage: string;
const tenant = "https://prod.id.forgerock.io";

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "pull-"));
  nock.disableNetConnect();
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("pullAllJourneys", () => {
  it("fetches all realms × journeys and writes them under a fresh snapshot dir", async () => {
    nock(tenant)
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, {
        result: [{ _id: "alpha-id", name: "alpha", parentPath: "/" }],
        resultCount: 1
      });
    nock(tenant)
      .get("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees?_queryFilter=true")
      .reply(200, { result: [{ _id: "Login" }, { _id: "Register" }], resultCount: 2 });
    nock(tenant)
      .get("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Login")
      .reply(200, { _id: "Login", entryNodeId: "a" });
    nock(tenant)
      .get("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Register")
      .reply(200, { _id: "Register", entryNodeId: "b" });

    const cache = { get: async () => "token", invalidate: () => {} };
    const result = await pullAllJourneys({
      tenantUrl: tenant,
      tokenCache: cache,
      envName: "prod",
      globalStoragePath: storage
    });

    expect(result.realmCount).toBe(1);
    expect(result.journeyCount).toBe(2);

    const dir = latestSnapshotDir(storage, "prod");
    expect(dir).toBeDefined();
    expect(existsSync(journeyFile(dir!, "alpha", "Login"))).toBe(true);
    expect(existsSync(journeyFile(dir!, "alpha", "Register"))).toBe(true);
  });

  it("creates an empty snapshot dir when env has no realms", async () => {
    nock(tenant)
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, { result: [], resultCount: 0 });

    const cache = { get: async () => "token", invalidate: () => {} };
    const result = await pullAllJourneys({
      tenantUrl: tenant,
      tokenCache: cache,
      envName: "prod",
      globalStoragePath: storage
    });
    expect(result.realmCount).toBe(0);
    expect(result.journeyCount).toBe(0);
    expect(latestSnapshotDir(storage, "prod")).toBeDefined();
  });
});
