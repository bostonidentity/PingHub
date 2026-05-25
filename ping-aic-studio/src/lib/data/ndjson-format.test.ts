import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isNDJsonFormat, NDJSON_FILE, OFFSETS_FILE } from "./ndjson-format";

let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-fmt-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("isNDJsonFormat", () => {
  it("returns false when data.ndjson is absent", () => {
    expect(isNDJsonFormat(tmpDir)).toBe(false);
  });

  it("returns true when data.ndjson exists", () => {
    fs.writeFileSync(path.join(tmpDir, NDJSON_FILE), "");
    expect(isNDJsonFormat(tmpDir)).toBe(true);
  });

  it("returns false when only legacy {id}.json files exist", () => {
    fs.writeFileSync(path.join(tmpDir, "u1.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "_manifest.json"), "{}");
    expect(isNDJsonFormat(tmpDir)).toBe(false);
  });

  it("exports the conventional file names", () => {
    expect(NDJSON_FILE).toBe("data.ndjson");
    expect(OFFSETS_FILE).toBe("_offsets.json");
  });
});
