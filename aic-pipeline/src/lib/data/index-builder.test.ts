import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { buildIndexFromNDJson } from "./index-builder";
import { openIndexDb } from "./index-db";
import { NDJSON_FILE } from "./ndjson-format";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idx-build-"));
}

function pickFields(r: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

function writeNDJson(dir: string, lines: object[]): void {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, NDJSON_FILE), text);
}

describe("buildIndexFromNDJson", () => {
  it("populates rows with correct offset, length, fields_json, searchable", async () => {
    const dir = tmpDir();
    writeNDJson(dir, [
      { _id: "a", userName: "Alice", givenName: "A" },
      { _id: "b", userName: "Bob", givenName: "B" },
    ]);
    const n = await buildIndexFromNDJson(dir, pickFields);
    expect(n).toBe(2);

    const db = openIndexDb(dir);
    const rows = db.prepare("SELECT id, ord, offset, length, fields_json, searchable FROM records ORDER BY ord").all() as Array<{
      id: string; ord: number; offset: number; length: number; fields_json: string; searchable: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("a");
    expect(rows[0].ord).toBe(0);
    expect(rows[0].offset).toBe(0);
    expect(rows[0].length).toBe(JSON.stringify({ _id: "a", userName: "Alice", givenName: "A" }).length);
    expect(JSON.parse(rows[0].fields_json)).toEqual({ _id: "a", userName: "Alice", givenName: "A" });
    expect(rows[0].searchable).toContain("alice");
    expect(rows[1].offset).toBe(rows[0].length + 1); // +1 for the newline
    db.close();
  });

  it("is idempotent — second call truncates and rebuilds", async () => {
    const dir = tmpDir();
    writeNDJson(dir, [{ _id: "a", userName: "A" }]);
    await buildIndexFromNDJson(dir, pickFields);
    writeNDJson(dir, [{ _id: "x", userName: "X" }, { _id: "y", userName: "Y" }]);
    const n = await buildIndexFromNDJson(dir, pickFields);
    expect(n).toBe(2);

    const db = openIndexDb(dir);
    const ids = (db.prepare("SELECT id FROM records ORDER BY ord").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["x", "y"]);
    db.close();
  });
});
