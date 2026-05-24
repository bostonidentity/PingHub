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
