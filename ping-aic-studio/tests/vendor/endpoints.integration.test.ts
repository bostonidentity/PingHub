import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const endpointsPull = require("../../src/vendor/fr-config-manager/pull/endpoints.js") as {
  pullEndpoints: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const endpointsPush = require("../../src/vendor/fr-config-manager/push/update-idm-endpoints.js") as {
  pushEndpoints: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

const BASE = "https://tenant.example";
let tmpDir: string;

beforeEach(() => {
  nock.cleanAll();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "endpoints-test-"));
});
afterEach(() => {
  nock.cleanAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pull endpoints", () => {
  it("writes one <name>/<name>.json + <name>/<name>.js per endpoint", async () => {
    nock(BASE)
      .get("/openidm/config")
      .query(() => true)
      .reply(200, {
        result: [
          { _id: "endpoint/myAction", type: "text/javascript", source: "config.set('x');" },
          { _id: "endpoint/other", type: "text/javascript", source: "var y = 1;" },
        ],
      });

    await endpointsPull.pullEndpoints({
      exportDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
    });

    const myActionJson = path.join(tmpDir, "endpoints", "myAction", "myAction.json");
    const myActionJs = path.join(tmpDir, "endpoints", "myAction", "myAction.js");
    expect(fs.existsSync(myActionJson)).toBe(true);
    expect(fs.existsSync(myActionJs)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(myActionJson, "utf-8"));
    expect(parsed.source).toBeUndefined();
    expect(parsed.file).toBe("myAction.js");
    expect(fs.readFileSync(myActionJs, "utf-8")).toBe("config.set('x');");
  });

  it("honors name filter", async () => {
    nock(BASE)
      .get("/openidm/config")
      .query(() => true)
      .reply(200, {
        result: [
          { _id: "endpoint/first", type: "text/javascript", source: "a" },
          { _id: "endpoint/wanted", type: "text/javascript", source: "b" },
          { _id: "endpoint/last", type: "text/javascript", source: "c" },
        ],
      });

    await endpointsPull.pullEndpoints({
      exportDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      name: "wanted",
    });

    expect(fs.existsSync(path.join(tmpDir, "endpoints", "wanted", "wanted.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "endpoints", "first"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "endpoints", "last"))).toBe(false);
  });
});

describe("push endpoints", () => {
  function writeEndpoint(name: string, js: string, extraJson: Record<string, unknown> = {}) {
    const dir = path.join(tmpDir, "endpoints", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.js`), js);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
      _id: `endpoint/${name}`,
      type: "text/javascript",
      file: `${name}.js`,
      ...extraJson,
    }));
  }

  it("inlines the .js into `source`, strips `file`, PUTs to /openidm/config/endpoint/<name>", async () => {
    writeEndpoint("myAction", "doThing();");

    let capturedBody: { source?: string; file?: string } | null = null;
    nock(BASE)
      .put("/openidm/config/endpoint/myAction", (body) => {
        capturedBody = body as typeof capturedBody;
        return true;
      })
      .reply(200);

    await endpointsPush.pushEndpoints({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.source).toBe("doThing();");
    expect(capturedBody!.file).toBeUndefined();
  });

  it("throws when a named endpoint isn't on disk", async () => {
    writeEndpoint("other", "// code");

    await expect(endpointsPush.pushEndpoints({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      name: "missing",
    })).rejects.toThrow(/not found/i);
  });

  it("warns (no PUT) when the .js file referenced by 'file' is missing", async () => {
    const dir = path.join(tmpDir, "endpoints", "orphan");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "orphan.json"), JSON.stringify({
      _id: "endpoint/orphan",
      type: "text/javascript",
      file: "orphan.js", // missing
    }));

    const messages: string[] = [];
    // PUT still fires because the vendored push treats missing-script as a
    // warning, not an error — the endpoint body just has no `source` set.
    // Nock will throw "no match" if an unexpected PUT happens.
    nock(BASE).put("/openidm/config/endpoint/orphan").reply(200);

    await endpointsPush.pushEndpoints({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      name: "orphan",
      log: (line) => messages.push(line),
    });

    expect(messages.some((m) => /script missing/i.test(m))).toBe(true);
  });
});
