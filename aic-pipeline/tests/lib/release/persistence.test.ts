import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readReleaseInfo, writeReleaseInfo } from "@/lib/release/persistence";
import type { ReleaseCacheEntry } from "@/lib/release/types";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rel-persist-"));
  fs.mkdirSync(path.join(tmp, "environments/dev"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const success = (): ReleaseCacheEntry => ({
  fetchedAt: "2026-04-23T10:00:00.000Z",
  info: { channel: "regular", currentVersion: "2026.03.02", nextUpgrade: "2026-05-05T02:00:00Z" },
});

describe("readReleaseInfo", () => {
  it("returns null when the file does not exist", () => {
    expect(readReleaseInfo("dev", { rootDir: tmp })).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    fs.writeFileSync(path.join(tmp, "environments/dev/release.json"), "{bad");
    expect(readReleaseInfo("dev", { rootDir: tmp })).toBeNull();
  });
});

describe("writeReleaseInfo + read round-trip", () => {
  it("writes and reads back the same entry", () => {
    writeReleaseInfo("dev", success(), { rootDir: tmp });
    expect(readReleaseInfo("dev", { rootDir: tmp })).toEqual(success());
  });

  it("persists an error entry with no info", () => {
    const errEntry: ReleaseCacheEntry = { fetchedAt: "2026-04-23T10:00:00.000Z", error: "HTTP 503" };
    writeReleaseInfo("dev", errEntry, { rootDir: tmp });
    expect(readReleaseInfo("dev", { rootDir: tmp })).toEqual(errEntry);
  });

  it("creates the env directory if missing", () => {
    writeReleaseInfo("brand-new", success(), { rootDir: tmp });
    expect(fs.existsSync(path.join(tmp, "environments/brand-new/release.json"))).toBe(true);
  });
});
