import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const flatPull = require("../../src/vendor/fr-config-manager/pull/idm-flat-config.js") as {
  pullIdmFlatConfig: (opts: { exportDir: string; subdir: string; filename: string; endpointName: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const flatPush = require("../../src/vendor/fr-config-manager/push/idm-flat-config.js") as {
  pushIdmFlatConfig: (opts: { configDir: string; subdir: string; filename: string; endpointName: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};

const BASE = "https://tenant.example";
let tmpDir: string;

beforeEach(() => {
  nock.cleanAll();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-test-"));
});
afterEach(() => {
  nock.cleanAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pullIdmFlatConfig (audit scope shape)", () => {
  it("GETs the configured endpoint and writes one file", async () => {
    const body = { queries: { activity: true }, type: "fs" };
    nock(BASE).get("/openidm/config/audit").reply(200, body);

    await flatPull.pullIdmFlatConfig({
      exportDir: tmpDir,
      subdir: "audit",
      filename: "audit.json",
      endpointName: "audit",
      tenantUrl: BASE,
      token: "tok",
    });

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, "audit", "audit.json"), "utf-8"));
    expect(written).toEqual(body);
  });

  it("creates the subdir if it doesn't exist", async () => {
    nock(BASE).get("/openidm/config/ui/configuration").reply(200, { ui: true });
    await flatPull.pullIdmFlatConfig({
      exportDir: tmpDir,
      subdir: "ui",
      filename: "ui-configuration.json",
      endpointName: "ui/configuration",
      tenantUrl: BASE,
      token: "tok",
    });
    expect(fs.existsSync(path.join(tmpDir, "ui", "ui-configuration.json"))).toBe(true);
  });

  it("propagates upstream 5xx errors after retries", async () => {
    nock(BASE).get("/openidm/config/audit").times(3).reply(500);
    await expect(flatPull.pullIdmFlatConfig({
      exportDir: tmpDir,
      subdir: "audit",
      filename: "audit.json",
      endpointName: "audit",
      tenantUrl: BASE,
      token: "tok",
    })).rejects.toThrow();
  });
});

describe("pushIdmFlatConfig (audit scope shape)", () => {
  it("reads the file and PUTs it to the endpoint", async () => {
    const body = { newAuditConfig: true };
    fs.mkdirSync(path.join(tmpDir, "audit"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "audit", "audit.json"), JSON.stringify(body));

    const scope = nock(BASE).put("/openidm/config/audit", body).reply(200, { ok: true });

    await flatPush.pushIdmFlatConfig({
      configDir: tmpDir,
      subdir: "audit",
      filename: "audit.json",
      endpointName: "audit",
      tenantUrl: BASE,
      token: "tok",
    });
    expect(scope.isDone()).toBe(true);
  });

  it("warns and returns early when the dir is missing (no PUT)", async () => {
    const messages: string[] = [];
    await flatPush.pushIdmFlatConfig({
      configDir: tmpDir, // empty
      subdir: "audit",
      filename: "audit.json",
      endpointName: "audit",
      tenantUrl: BASE,
      token: "tok",
      log: (line) => messages.push(line),
    });
    expect(messages.some((m) => m.startsWith("Warning:"))).toBe(true);
  });

  it("warns when the file is missing (no PUT)", async () => {
    fs.mkdirSync(path.join(tmpDir, "audit"), { recursive: true });
    const messages: string[] = [];
    await flatPush.pushIdmFlatConfig({
      configDir: tmpDir,
      subdir: "audit",
      filename: "audit.json",
      endpointName: "audit",
      tenantUrl: BASE,
      token: "tok",
      log: (line) => messages.push(line),
    });
    expect(messages.some((m) => /missing/i.test(m))).toBe(true);
  });
});
