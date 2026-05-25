import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const managedPull = require("../../src/vendor/fr-config-manager/pull/managed.js") as {
  exportManagedObjects: (exportDir: string, tenantUrl: string, name: string | undefined, pullCustomRelationships: boolean, token: string) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const managedPush = require("../../src/vendor/fr-config-manager/push/update-managed-objects.js") as {
  updateManagedObjects: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

const BASE = "https://tenant.example";
let tmpDir: string;

beforeEach(() => {
  nock.cleanAll();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mo-test-"));
});
afterEach(() => {
  nock.cleanAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Pull ─────────────────────────────────────────────────────────────────────

describe("pull managed-objects", () => {
  it("writes each object to its own directory with extracted onUpdate.js", async () => {
    nock(BASE).get("/openidm/config/managed").reply(200, {
      objects: [
        {
          name: "alpha_user",
          schema: { type: "object", properties: {} },
          onUpdate: { type: "text/javascript", source: "logger.info('updated')" },
        },
        {
          name: "alpha_role",
          schema: { type: "object", properties: {} },
        },
      ],
    });

    await managedPull.exportManagedObjects(tmpDir, BASE, undefined, false, "tok");

    const userJsonPath = path.join(tmpDir, "managed-objects", "alpha_user", "alpha_user.json");
    const userScriptPath = path.join(tmpDir, "managed-objects", "alpha_user", "alpha_user.onUpdate.js");
    expect(fs.existsSync(userJsonPath)).toBe(true);
    expect(fs.existsSync(userScriptPath)).toBe(true);

    const userJson = JSON.parse(fs.readFileSync(userJsonPath, "utf-8"));
    expect(userJson.onUpdate).toEqual({ type: "text/javascript", file: "alpha_user.onUpdate.js" });
    expect(userJson.onUpdate.source).toBeUndefined();

    const scriptContent = fs.readFileSync(userScriptPath, "utf-8");
    expect(scriptContent).toBe("logger.info('updated')");

    // And the second object wrote its JSON too.
    const rolePath = path.join(tmpDir, "managed-objects", "alpha_role", "alpha_role.json");
    expect(fs.existsSync(rolePath)).toBe(true);
  });

  it("honors the name filter with continue (not return) — upstream bug fix", async () => {
    // IDM returns objects in arbitrary order; ensure we still find the target
    // when it's NOT first in the response.
    nock(BASE).get("/openidm/config/managed").reply(200, {
      objects: [
        { name: "alpha_user", schema: { type: "object", properties: {} } },
        { name: "alpha_role", schema: { type: "object", properties: {} } },
        { name: "alpha_target", schema: { type: "object", properties: {} } },
      ],
    });

    await managedPull.exportManagedObjects(tmpDir, BASE, "alpha_target", false, "tok");

    expect(fs.existsSync(path.join(tmpDir, "managed-objects", "alpha_target", "alpha_target.json"))).toBe(true);
    // Non-matches must NOT be written.
    expect(fs.existsSync(path.join(tmpDir, "managed-objects", "alpha_user"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "managed-objects", "alpha_role"))).toBe(false);
  });
});

// ── Push ─────────────────────────────────────────────────────────────────────

describe("push managed-objects", () => {
  function writeObject(name: string, body: unknown) {
    const dir = path.join(tmpDir, "managed-objects", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body));
  }

  it("without name: PUTs every object in the temp dir as a single envelope", async () => {
    writeObject("alpha_user", { name: "alpha_user", schema: { properties: {} } });
    writeObject("alpha_role", { name: "alpha_role", schema: { properties: {} } });

    let capturedBody: unknown = null;
    nock(BASE).put("/openidm/config/managed", (body) => { capturedBody = body; return true; }).reply(200);
    nock(BASE).get("/openidm/config/managed").reply(200, { objects: [] }); // post-PUT "avoid 404" GET

    await managedPush.updateManagedObjects({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
    });

    expect(capturedBody).not.toBeNull();
    const envelope = capturedBody as { objects: Array<{ name: string }> };
    expect(envelope.objects.map((o) => o.name).sort()).toEqual(["alpha_role", "alpha_user"]);
  });

  it("with name: merges into target's current set (GET → splice → PUT)", async () => {
    writeObject("alpha_target", {
      name: "alpha_target",
      schema: { properties: {} },
    });

    // mergeExistingObjects: first GET to fetch existing envelope
    nock(BASE).get("/openidm/config/managed").reply(200, {
      objects: [
        { name: "alpha_user", schema: { properties: {} } },
        { name: "alpha_target", schema: { properties: { stale: true } } }, // will be replaced
        { name: "alpha_role", schema: { properties: {} } },
      ],
    });

    let capturedBody: { objects: Array<{ name: string; schema: { properties: Record<string, unknown> } }> } | null = null;
    nock(BASE).put("/openidm/config/managed", (body) => { capturedBody = body as typeof capturedBody; return true; }).reply(200);
    nock(BASE).get("/openidm/config/managed").reply(200, { objects: [] }); // post-PUT

    await managedPush.updateManagedObjects({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      name: "alpha_target",
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.objects.length).toBe(3);
    const names = capturedBody!.objects.map((o) => o.name).sort();
    expect(names).toEqual(["alpha_role", "alpha_target", "alpha_user"]);
    // The target must be the new version (no `stale` flag).
    const target = capturedBody!.objects.find((o) => o.name === "alpha_target")!;
    expect((target.schema.properties as Record<string, unknown>).stale).toBeUndefined();
  });

  it("throws when --name is given but the object isn't on disk", async () => {
    writeObject("other_one", { name: "other_one", schema: { properties: {} } });

    await expect(managedPush.updateManagedObjects({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
      name: "alpha_target",
    })).rejects.toThrow(/not found/i);
  });

  it("inlines a companion .js script into the object's onUpdate field", async () => {
    const dir = path.join(tmpDir, "managed-objects", "alpha_user");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "alpha_user.json"), JSON.stringify({
      name: "alpha_user",
      schema: { properties: {} },
      onUpdate: { type: "text/javascript", file: "alpha_user.onUpdate.js" },
    }));
    fs.writeFileSync(path.join(dir, "alpha_user.onUpdate.js"), "logger.info('hi')");

    let capturedBody: { objects: Array<{ onUpdate?: { source?: string; file?: string } }> } | null = null;
    nock(BASE).put("/openidm/config/managed", (body) => { capturedBody = body as typeof capturedBody; return true; }).reply(200);
    nock(BASE).get("/openidm/config/managed").reply(200, { objects: [] });

    await managedPush.updateManagedObjects({
      configDir: tmpDir,
      tenantUrl: BASE,
      token: "tok",
    });

    const onUpdate = capturedBody!.objects[0].onUpdate!;
    expect(onUpdate.source).toBe("logger.info('hi')");
    expect(onUpdate.file).toBeUndefined();
  });
});
