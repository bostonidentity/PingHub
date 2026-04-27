import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStatus, writeStatus } from "@/lib/rcs/persistence";
import type { RcsStatusFile } from "@/lib/rcs/types";

let tmp: string;
let envsDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcs-persist-"));
  envsDir = path.join(tmp, "environments");
  fs.mkdirSync(path.join(envsDir, "dev"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mkFile = (): RcsStatusFile => ({
  checkedAt: "2026-04-23T12:00:00.000Z",
  durationMs: 123,
  provider: { path: "/x/y.json", mtime: "2026-04-01T00:00:00.000Z" },
  clusters: [
    {
      name: "rcs-cluster-external",
      kind: "clientGroup",
      overall: "ok",
      okCount: 2,
      totalCount: 2,
      members: [
        { name: "rcs-ext-1", ok: true, latencyMs: 30 },
        { name: "rcs-ext-2", ok: true, latencyMs: 45 },
      ],
      connectors: [
        { name: "ad-hr", ok: true, latencyMs: 123 },
        { name: "oracle-hr", ok: true, latencyMs: 456 },
      ],
    },
  ],
});

describe("readStatus", () => {
  it("returns null when the file does not exist", () => {
    expect(readStatus("dev", { rootDir: envsDir })).toBeNull();
  });

  it("returns null when the env directory itself does not exist", () => {
    expect(readStatus("never-created", { rootDir: envsDir })).toBeNull();
  });
});

describe("writeStatus + readStatus round-trip", () => {
  it("writes and then reads back the same object", () => {
    const file = mkFile();
    writeStatus("dev", file, { rootDir: envsDir });
    expect(readStatus("dev", { rootDir: envsDir })).toEqual(file);
  });

  it("creates the env directory if it was missing", () => {
    const file = mkFile();
    writeStatus("brand-new", file, { rootDir: envsDir });
    expect(fs.existsSync(path.join(envsDir, "brand-new/rcs-status.json"))).toBe(true);
  });
});
