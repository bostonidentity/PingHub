// src/core/push/pushJourney.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushJourneyFromSnapshot } from "./pushJourney";

let storage: string;

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "pushj-"));
  nock.disableNetConnect();
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

function seedSnapshot(envName: string, stamp: string, realm: string, id: string, body: unknown) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("pushJourneyFromSnapshot", () => {
  it("reads the journey from the source env's latest snapshot and PUTs to the target", async () => {
    seedSnapshot("prod", "2026-05-24T15-30-00Z", "alpha", "Login", { _id: "Login", entryNodeId: "src" });

    nock("https://stage.id.forgerock.io")
      .put("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Login")
      .reply(200, { _id: "Login", _rev: "5" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const res = await pushJourneyFromSnapshot({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      realm: "alpha",
      journeyId: "Login"
    });
    expect(res.ok).toBe(true);
  });

  it("throws when source snapshot does not contain the journey", async () => {
    const cache = { get: async () => "t", invalidate: () => {} };
    await expect(
      pushJourneyFromSnapshot({
        globalStoragePath: storage,
        sourceEnvName: "prod",
        targetTenantUrl: "https://stage.id.forgerock.io",
        targetTokenCache: cache,
        realm: "alpha",
        journeyId: "Missing"
      })
    ).rejects.toThrow(/no snapshot|not found/i);
  });
});
