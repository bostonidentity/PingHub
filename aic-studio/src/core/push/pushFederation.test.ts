// src/core/push/pushFederation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushFederationFromSnapshot } from "./pushFederation";

let storage: string;

beforeEach(() => { storage = mkdtempSync(join(tmpdir(), "pushf-")); nock.disableNetConnect(); });
afterEach(() => { rmSync(storage, { recursive: true, force: true }); nock.cleanAll(); nock.enableNetConnect(); });

function seed(envName: string, stamp: string, realm: string, type: string, id: string, body: unknown) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "federation", type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("pushFederationFromSnapshot", () => {
  it("PUTs SAML2 provider to target env", async () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "saml2", "sp-acme", { _id: "sp-acme", x: 1 });
    nock("https://stage.id.forgerock.io").put(/saml2\/sp-acme$/).reply(200, { _id: "sp-acme", _rev: "2" });
    const cache = { get: async () => "t", invalidate: () => {} };
    const r = await pushFederationFromSnapshot({
      globalStoragePath: storage, sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
      realm: "alpha", type: "saml2", id: "sp-acme"
    });
    expect(r.ok).toBe(true);
  });

  it("PUTs OIDC client to target env", async () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "OAuth2Client", "client-a", { _id: "client-a" });
    nock("https://stage.id.forgerock.io").put(/OAuth2Client\/client-a$/).reply(200, { _id: "client-a" });
    const cache = { get: async () => "t", invalidate: () => {} };
    const r = await pushFederationFromSnapshot({
      globalStoragePath: storage, sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
      realm: "alpha", type: "OAuth2Client", id: "client-a"
    });
    expect(r.ok).toBe(true);
  });

  it("throws on missing snapshot", async () => {
    const cache = { get: async () => "t", invalidate: () => {} };
    await expect(pushFederationFromSnapshot({
      globalStoragePath: storage, sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
      realm: "alpha", type: "saml2", id: "missing"
    })).rejects.toThrow(/no snapshot|not found/i);
  });

  it("throws on unsupported federation type", async () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "wsfed", "x", { _id: "x" });
    const cache = { get: async () => "t", invalidate: () => {} };
    await expect(pushFederationFromSnapshot({
      globalStoragePath: storage, sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
      realm: "alpha", type: "wsfed", id: "x"
    })).rejects.toThrow(/unsupported/i);
  });
});
