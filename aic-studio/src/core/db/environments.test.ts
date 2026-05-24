import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import { insertEnvironment, getEnvironmentByName } from "./environments";
import type { NewEnvironment } from "../env/types";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "aic-env-test-"));
  db = openDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const sample: NewEnvironment = {
  name: "prod-tenant",
  label: "Production",
  tenantUrl: "https://prod.id.forgerock.io",
  username: "service-account@example.com",
  clientId: "service-client",
  color: "blue"
};

describe("insertEnvironment", () => {
  it("inserts a new env with auto timestamps", () => {
    const before = Date.now();
    insertEnvironment(db, sample);
    const after = Date.now();

    const env = getEnvironmentByName(db, "prod-tenant");
    expect(env).toBeDefined();
    expect(env?.name).toBe("prod-tenant");
    expect(env?.label).toBe("Production");
    expect(env?.tenantUrl).toBe("https://prod.id.forgerock.io");
    expect(env?.color).toBe("blue");
    expect(env?.createdAt).toBeGreaterThanOrEqual(before);
    expect(env?.createdAt).toBeLessThanOrEqual(after);
    expect(env?.updatedAt).toBe(env?.createdAt);
  });

  it("rejects duplicate name", () => {
    insertEnvironment(db, sample);
    expect(() => insertEnvironment(db, sample)).toThrow(/UNIQUE constraint|already exists/i);
  });
});

describe("getEnvironmentByName", () => {
  it("returns undefined for unknown name", () => {
    expect(getEnvironmentByName(db, "missing")).toBeUndefined();
  });
});

import { listEnvironments, removeEnvironment } from "./environments";

describe("listEnvironments", () => {
  it("returns empty array when no envs", () => {
    expect(listEnvironments(db)).toEqual([]);
  });

  it("returns envs sorted by name", () => {
    insertEnvironment(db, { ...sample, name: "zeta", label: "Zeta" });
    insertEnvironment(db, { ...sample, name: "alpha", label: "Alpha" });
    insertEnvironment(db, { ...sample, name: "mu", label: "Mu" });
    const envs = listEnvironments(db);
    expect(envs.map((e) => e.name)).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("removeEnvironment", () => {
  it("removes the named env", () => {
    insertEnvironment(db, sample);
    expect(getEnvironmentByName(db, sample.name)).toBeDefined();
    removeEnvironment(db, sample.name);
    expect(getEnvironmentByName(db, sample.name)).toBeUndefined();
  });

  it("is a no-op for unknown name", () => {
    expect(() => removeEnvironment(db, "missing")).not.toThrow();
  });
});
