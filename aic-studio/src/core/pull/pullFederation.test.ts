// src/core/pull/pullFederation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullAllFederation } from "./pullFederation";
import { federationFile } from "../snapshots/paths";

let storage: string;
const tenant = "https://prod.id.forgerock.io";

beforeEach(() => { storage = mkdtempSync(join(tmpdir(), "pullf-")); nock.disableNetConnect(); });
afterEach(() => { rmSync(storage, { recursive: true, force: true }); nock.cleanAll(); nock.enableNetConnect(); });

describe("pullAllFederation", () => {
  it("pulls SAML2 + OIDC for given realms and writes them under fresh snapshot dir", async () => {
    const snapshotDir = join(storage, "snapshots", "prod", "2026-05-24T15-30-00Z");
    mkdirSync(snapshotDir, { recursive: true });

    nock(tenant)
      .get(/saml2\?_queryFilter=true/).reply(200, { result: [{ _id: "sp-acme" }], resultCount: 1 })
      .get(/saml2\/sp-acme$/).reply(200, { _id: "sp-acme", entityID: "acme" })
      .get(/OAuth2Client\?_queryFilter=true/).reply(200, { result: [{ _id: "client-a" }], resultCount: 1 })
      .get(/OAuth2Client\/client-a$/).reply(200, { _id: "client-a" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const result = await pullAllFederation({
      tenantUrl: tenant,
      tokenCache: cache,
      envName: "prod",
      globalStoragePath: storage,
      realms: ["alpha"],
      snapshotDir
    });

    expect(result.itemCount).toBe(2);
    expect(existsSync(federationFile(snapshotDir, "alpha", "saml2", "sp-acme"))).toBe(true);
    expect(existsSync(federationFile(snapshotDir, "alpha", "OAuth2Client", "client-a"))).toBe(true);
  });

  it("returns zero count when realms have no federation items", async () => {
    const snapshotDir = join(storage, "snapshots", "prod", "2026-05-24T15-30-00Z");
    mkdirSync(snapshotDir, { recursive: true });

    nock(tenant)
      .get(/saml2\?_queryFilter=true/).reply(200, { result: [], resultCount: 0 })
      .get(/OAuth2Client\?_queryFilter=true/).reply(200, { result: [], resultCount: 0 });

    const cache = { get: async () => "t", invalidate: () => {} };
    const result = await pullAllFederation({
      tenantUrl: tenant,
      tokenCache: cache,
      envName: "prod",
      globalStoragePath: storage,
      realms: ["alpha"],
      snapshotDir
    });

    expect(result.itemCount).toBe(0);
  });
});
