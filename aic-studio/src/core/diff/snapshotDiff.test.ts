import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLocallyModifiedJourneys } from "./snapshotDiff";

let storage: string;
beforeEach(() => { storage = mkdtempSync(join(tmpdir(), "diff-")); });
afterEach(() => { rmSync(storage, { recursive: true, force: true }); });

function seed(envName: string, stamp: string, realm: string, id: string, body: unknown, mtime?: Date) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
  if (mtime) {
    const stampDir = join(storage, "snapshots", envName, stamp);
    utimesSync(stampDir, mtime, mtime);
  }
}

describe("findLocallyModifiedJourneys", () => {
  it("returns [] when there's only one snapshot", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login", v: 1 });
    expect(findLocallyModifiedJourneys(storage, "prod")).toEqual([]);
  });

  it("returns items where the latest snapshot differs from the previous one", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login", v: 1 }, new Date(2024, 0, 1));
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Register", { _id: "Register", v: 1 }, new Date(2024, 0, 1));
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "Login", { _id: "Login", v: 2 }, new Date(2024, 0, 2));
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "Register", { _id: "Register", v: 1 }, new Date(2024, 0, 2));
    const diffs = findLocallyModifiedJourneys(storage, "prod");
    expect(diffs).toEqual([{ realm: "alpha", resourceType: "journey", resourceId: "Login" }]);
  });

  it("treats items present in latest but not in prior as modified", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login", v: 1 }, new Date(2024, 0, 1));
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "Login", { _id: "Login", v: 1 }, new Date(2024, 0, 2));
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "NewOne", { _id: "NewOne" }, new Date(2024, 0, 2));
    const diffs = findLocallyModifiedJourneys(storage, "prod");
    expect(diffs).toContainEqual({ realm: "alpha", resourceType: "journey", resourceId: "NewOne" });
  });
});
