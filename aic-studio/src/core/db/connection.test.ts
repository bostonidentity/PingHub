import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./connection";
import { SCHEMA_VERSION } from "./schema";

let tmpDirs: string[] = [];

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "aic-studio-test-"));
  tmpDirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("openDatabase", () => {
  it("creates a new database and runs all migrations", () => {
    const db = openDatabase(tmpDb());
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it("is idempotent — re-opening the same DB does not error", () => {
    const path = tmpDb();
    const db1 = openDatabase(path);
    db1.close();
    const db2 = openDatabase(path);
    const row = db2.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db2.close();
  });
});
