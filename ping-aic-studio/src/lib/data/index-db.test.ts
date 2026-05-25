import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { openIndexDb, INDEX_DB_FILE, SCHEMA_VERSION } from "./index-db";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idx-db-"));
}

describe("index-db", () => {
  it("creates schema on first open", () => {
    const dir = tmpDir();
    const db = openIndexDb(dir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["meta", "records"]);
    const v = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    db.close();
    expect(fs.existsSync(path.join(dir, INDEX_DB_FILE))).toBe(true);
  });

  it("reuses an existing DB without re-creating tables", () => {
    const dir = tmpDir();
    const a = openIndexDb(dir);
    a.prepare("INSERT INTO meta(key,value) VALUES ('mark','x')").run();
    a.close();
    const b = openIndexDb(dir);
    const row = b.prepare("SELECT value FROM meta WHERE key='mark'").get() as { value: string };
    expect(row.value).toBe("x");
    b.close();
  });
});
