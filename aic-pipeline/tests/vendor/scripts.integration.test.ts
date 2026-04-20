import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scriptsPull = require("../../src/vendor/fr-config-manager/pull/scripts.js") as {
  exportScripts: (opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; prefixes?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
  exportScriptById: (opts: { exportDir: string; tenantUrl: string; realm: string; id: string; token: string }) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scriptsPush = require("../../src/vendor/fr-config-manager/push/update-scripts.js") as {
  updateScripts: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
  pushScriptById: (opts: { configDir: string; scriptId: string; tenantUrl: string; realm: string; token: string; log?: (line: string) => void }) => Promise<void>;
};

const BASE = "https://tenant.example";
let tmpDir: string;

beforeEach(() => {
  nock.cleanAll();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-test-"));
});
afterEach(() => {
  nock.cleanAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pull scripts", () => {
  it("filters JAVASCRIPT scripts, extracts content to .js, writes config JSON", async () => {
    nock(BASE)
      .get("/am/json/alpha/scripts")
      .query(() => true)
      .reply(200, {
        result: [
          {
            _id: "uuid-1",
            name: "MyScript",
            context: "AUTHENTICATION_TREE_DECISION_NODE",
            language: "JAVASCRIPT",
            script: Buffer.from("logger.info('hello')").toString("base64"),
          },
          {
            _id: "uuid-skip",
            name: "GroovyThing",
            context: "AUTHENTICATION_TREE_DECISION_NODE",
            language: "GROOVY",
            script: Buffer.from("// groovy code").toString("base64"),
          },
        ],
      });

    await scriptsPull.exportScripts({
      exportDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      realms: ["alpha"],
      prefixes: [""],
    });

    const configFile = path.join(tmpDir, "alpha", "scripts", "scripts-config", "uuid-1.json");
    const contentFile = path.join(tmpDir, "alpha", "scripts", "scripts-content", "AUTHENTICATION_TREE_DECISION_NODE", "MyScript.js");
    expect(fs.existsSync(configFile)).toBe(true);
    expect(fs.existsSync(contentFile)).toBe(true);

    expect(fs.readFileSync(contentFile, "utf-8")).toBe("logger.info('hello')");
    const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(cfg.script).toEqual({ file: "scripts-content/AUTHENTICATION_TREE_DECISION_NODE/MyScript.js" });

    // Groovy script should not be written.
    expect(fs.existsSync(path.join(tmpDir, "alpha", "scripts", "scripts-config", "uuid-skip.json"))).toBe(false);
  });

  it("honors prefixes filter in the queryFilter", async () => {
    const reqCapture: string[] = [];
    nock(BASE)
      .get("/am/json/alpha/scripts")
      .query((q) => {
        reqCapture.push(q._queryFilter as string);
        return true;
      })
      .reply(200, { result: [] });

    await scriptsPull.exportScripts({
      exportDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      realms: ["alpha"],
      prefixes: ["kyid-", "common-"],
    });

    // `+` in the queryFilter is URL-encoded to spaces in transit — the server
    // sees the decoded form. Matches upstream's queryFilter composition.
    expect(reqCapture[0]).toBe('name sw "kyid-" or name sw "common-"');
  });
});

describe("push scripts", () => {
  function writeScript(realm: string, uuid: string, name: string, context: string, js: string) {
    const cfgDir = path.join(tmpDir, "realms", realm, "scripts", "scripts-config");
    const contentDir = path.join(tmpDir, "realms", realm, "scripts", "scripts-content", context);
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, `${name}.js`), js);
    fs.writeFileSync(path.join(cfgDir, `${uuid}.json`), JSON.stringify({
      _id: uuid,
      name,
      context,
      language: "JAVASCRIPT",
      description: null, // exercises the null→"" fix
      script: { file: `scripts-content/${context}/${name}.js` },
    }));
  }

  it("PUTs each script, inlines the .js source, awaits each call (no races)", async () => {
    writeScript("alpha", "uuid-1", "ScriptOne", "AUTHENTICATION_TREE_DECISION_NODE", "logger.info('1')");
    writeScript("alpha", "uuid-2", "ScriptTwo", "AUTHENTICATION_TREE_DECISION_NODE", "logger.info('2')");

    const calls: Array<{ id: string; body: unknown }> = [];
    nock(BASE)
      .put("/am/json/realms/root/realms/alpha/scripts/uuid-1", (b) => { calls.push({ id: "uuid-1", body: b }); return true; })
      .reply(200);
    nock(BASE)
      .put("/am/json/realms/root/realms/alpha/scripts/uuid-2", (b) => { calls.push({ id: "uuid-2", body: b }); return true; })
      .reply(200);

    await scriptsPush.updateScripts({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      realms: ["alpha"],
    });

    expect(calls.length).toBe(2);
    for (const call of calls) {
      const body = call.body as { script: string; description: string };
      // Source has been inlined and base64-encoded.
      expect(typeof body.script).toBe("string");
      expect(Buffer.from(body.script, "base64").toString("utf-8")).toMatch(/logger\.info\('\d'\)/);
      // description null → ""
      expect(body.description).toBe("");
    }
  });

  it("surfaces a push failure instead of swallowing it (await bug fix)", async () => {
    writeScript("alpha", "uuid-bad", "BadScript", "X", "// code");

    // Return 500 three times to exhaust retries
    nock(BASE).put("/am/json/realms/root/realms/alpha/scripts/uuid-bad").times(3).reply(500);

    await expect(scriptsPush.updateScripts({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      realms: ["alpha"],
    })).rejects.toThrow();
  });

  it("throws when named script is not found", async () => {
    writeScript("alpha", "uuid-1", "Other", "X", "// code");

    await expect(scriptsPush.updateScripts({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      realms: ["alpha"],
      name: "NotThere",
    })).rejects.toThrow(/not found/i);
  });
});
