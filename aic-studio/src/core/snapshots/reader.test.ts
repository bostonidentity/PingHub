import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJourneyFromLatest, listRealmsInLatest, listJourneysInLatest } from "./reader";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "snap-reader-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seed(envName: string, stamp: string, realm: string, files: Record<string, unknown>) {
  const dir = join(root, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  for (const [id, body] of Object.entries(files)) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
  }
}

describe("snapshot reader", () => {
  it("reads a journey from the latest snapshot", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { Login: { _id: "Login", x: 1 } });
    expect(readJourneyFromLatest(root, "prod", "alpha", "Login")).toEqual({ _id: "Login", x: 1 });
  });

  it("returns undefined when no snapshot exists", () => {
    expect(readJourneyFromLatest(root, "prod", "alpha", "Login")).toBeUndefined();
  });

  it("lists realms in the latest snapshot", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { L: {} });
    seed("prod", "2026-05-24T15-30-00Z", "bravo", { R: {} });
    expect(listRealmsInLatest(root, "prod").sort()).toEqual(["alpha", "bravo"]);
  });

  it("lists journeys in a realm of the latest snapshot", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { Login: {}, Register: {} });
    expect(listJourneysInLatest(root, "prod", "alpha").sort()).toEqual(["Login", "Register"]);
  });

  it("returns [] when realm directory missing", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { L: {} });
    expect(listJourneysInLatest(root, "prod", "missing")).toEqual([]);
  });
});
