import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { scanJourneyNames } from "./journey-list";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "journeys-"));
}
function mkJourney(configDir: string, realm: string, name: string) {
  fs.mkdirSync(path.join(configDir, realm, "journeys", name), { recursive: true });
}

describe("scanJourneyNames", () => {
  it("returns sorted, de-duped journey names across realms", () => {
    const dir = tmpDir();
    mkJourney(dir, "alpha", "Login");
    mkJourney(dir, "alpha", "Agent");
    mkJourney(dir, "bravo", "Login"); // duplicate name in another realm
    const r = scanJourneyNames(dir);
    expect(r.source).toBe("config");
    expect(r.journeys).toEqual(["Agent", "Login"]);
  });

  it("returns source 'none' when the dir is null or missing", () => {
    expect(scanJourneyNames(null)).toEqual({ journeys: [], source: "none" });
    expect(scanJourneyNames(path.join(os.tmpdir(), "does-not-exist-xyz"))).toEqual({ journeys: [], source: "none" });
  });

  it("returns source 'none' when config exists but has no journeys", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "alpha"), { recursive: true });
    expect(scanJourneyNames(dir)).toEqual({ journeys: [], source: "none" });
  });
});
