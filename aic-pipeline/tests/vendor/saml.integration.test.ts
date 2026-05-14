import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nock from "nock";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const samlPull = require("../../src/vendor/fr-config-manager/pull/saml.js") as {
  pullSaml: (opts: {
    exportDir: string;
    tenantUrl: string;
    token: string;
    realms?: string[];
    descriptorFile?: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

const BASE = "https://tenant.example";
let tmpDir: string;

beforeEach(() => {
  nock.cleanAll();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saml-pull-"));
});

afterEach(() => {
  nock.cleanAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pull saml", () => {
  it("auto-discovers providers when no descriptor file is configured", async () => {
    nock(BASE)
      .get("/am/json/realms/root/realms/alpha/realm-config/saml2")
      .query((q) => q._queryFilter === "true")
      .reply(200, {
        result: [
          { _id: "hosted-id", entityId: "hosted-entity", location: "hosted" },
          { _id: "remote-id", entityId: "remote-entity", location: "remote" },
        ],
      })
      .get("/am/json/realms/root/realms/alpha/realm-config/saml2/hosted/hosted-id")
      .reply(200, { _id: "hosted-id", entityId: "hosted-entity" })
      .get("/am/saml2/jsp/exportmetadata.jsp")
      .query((q) => q.entityid === "hosted-entity")
      .reply(200, "<EntityDescriptor>hosted</EntityDescriptor>")
      .get("/am/json/realms/root/realms/alpha/realm-config/saml2/remote/remote-id")
      .reply(200, { _id: "remote-id", entityId: "remote-entity" })
      .get("/am/saml2/jsp/exportmetadata.jsp")
      .query((q) => q.entityid === "remote-entity")
      .reply(200, "<EntityDescriptor>remote</EntityDescriptor>")
      .get("/am/json/realms/root/realms/alpha/realm-config/federation/circlesoftrust")
      .query((q) => q._queryFilter === "true")
      .reply(200, { result: [{ _id: "cot-one" }] })
      .get("/am/json/realms/root/realms/alpha/realm-config/federation/circlesoftrust/cot-one")
      .reply(200, { _id: "cot-one", trustedProviders: ["hosted-entity"] });

    await samlPull.pullSaml({
      exportDir: tmpDir,
      tenantUrl: BASE,
      token: "token",
      realms: ["alpha"],
    });

    const hosted = JSON.parse(fs.readFileSync(path.join(tmpDir, "realms", "alpha", "realm-config", "saml", "hosted", "hosted_entity.json"), "utf-8"));
    const remote = JSON.parse(fs.readFileSync(path.join(tmpDir, "realms", "alpha", "realm-config", "saml", "remote", "remote_entity.json"), "utf-8"));
    const cot = JSON.parse(fs.readFileSync(path.join(tmpDir, "realms", "alpha", "realm-config", "saml", "COT", "cot_one.json"), "utf-8"));

    expect(hosted.config.entityId).toBe("hosted-entity");
    expect(hosted.metadata).toContain("hosted");
    expect(remote.config.entityId).toBe("remote-entity");
    expect(remote.metadata).toContain("remote");
    expect(cot.trustedProviders).toEqual(["hosted-entity"]);
  });

  it("keeps descriptor mode behavior when a descriptor file exists", async () => {
    const descriptorFile = path.join(tmpDir, "saml.json");
    fs.writeFileSync(descriptorFile, JSON.stringify({
      alpha: { samlProviders: [{ entityId: "known-entity" }], circlesOfTrust: [] },
    }));

    nock(BASE)
      .get("/am/json/realms/root/realms/alpha/realm-config/saml2")
      .query(() => true)
      .reply(200, { resultCount: 1, result: [{ _id: "known-id", entityId: "known-entity", location: "remote" }] })
      .get("/am/json/realms/root/realms/alpha/realm-config/saml2/remote/known-id")
      .reply(200, { _id: "known-id", entityId: "known-entity" })
      .get("/am/saml2/jsp/exportmetadata.jsp")
      .query(() => true)
      .reply(200, "<EntityDescriptor>known</EntityDescriptor>");

    await samlPull.pullSaml({
      exportDir: tmpDir,
      tenantUrl: BASE,
      token: "token",
      descriptorFile,
    });

    expect(fs.existsSync(path.join(tmpDir, "realms", "alpha", "realm-config", "saml", "remote", "known_entity.json"))).toBe(true);
  });
});
