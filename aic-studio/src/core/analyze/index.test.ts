import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUsage } from "./index";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "findusage-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seedJourney(envName: string, stamp: string, realm: string, id: string, body: unknown) {
  const dir = join(root, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("findUsage", () => {
  it("returns refs targeting a specific script across all journeys", () => {
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "Login", {
      _id: "Login",
      nodes: { "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "validateUser" } }
    });
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "Register", {
      _id: "Register",
      nodes: { "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "validateUser" } }
    });

    const result = findUsage(root, "prod", { realm: "alpha", resourceType: "script", id: "validateUser" });
    expect(result.refs).toHaveLength(2);
    expect(result.refs.map((r) => r.source.id).sort()).toEqual(["Login", "Register"]);
  });

  it("returns empty refs when target has no usages", () => {
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "Login", {
      _id: "Login", nodes: {}
    });
    const result = findUsage(root, "prod", { realm: "alpha", resourceType: "script", id: "unused" });
    expect(result.refs).toEqual([]);
    expect(result.target.id).toBe("unused");
  });

  it("ignores refs from other realms", () => {
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "L", {
      _id: "L", nodes: { "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "s1" } }
    });
    seedJourney("prod", "2026-05-24T10-00-00Z", "bravo", "L", {
      _id: "L", nodes: { "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "s1" } }
    });
    const result = findUsage(root, "prod", { realm: "alpha", resourceType: "script", id: "s1" });
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0].source.realm).toBe("alpha");
  });
});
