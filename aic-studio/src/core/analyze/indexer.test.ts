// src/core/analyze/indexer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexEnv } from "./indexer";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "indexer-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seedJourney(envName: string, stamp: string, realm: string, id: string, body: unknown) {
  const dir = join(root, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("indexEnv", () => {
  it("returns [] when env has no snapshots", () => {
    expect(indexEnv(root, "prod")).toEqual([]);
  });

  it("walks all journeys in latest snapshot and collects references", () => {
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "Login", {
      _id: "Login",
      nodes: {
        "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "validateUser" },
        "n2": { _id: "n2", _type: { _id: "InnerTreeEvaluatorNode" }, tree: "MfaJourney" }
      }
    });
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "MfaJourney", {
      _id: "MfaJourney",
      nodes: {
        "m1": { _id: "m1", _type: { _id: "ScriptedDecisionNode" }, script: "computeRisk" }
      }
    });
    const refs = indexEnv(root, "prod");
    expect(refs).toHaveLength(3);
    const scriptTargets = refs.filter((r) => r.target.resourceType === "script").map((r) => r.target.id);
    expect(scriptTargets.sort()).toEqual(["computeRisk", "validateUser"]);
    const journeyTargets = refs.filter((r) => r.target.resourceType === "journey").map((r) => r.target.id);
    expect(journeyTargets).toEqual(["MfaJourney"]);
  });

  it("includes refs from journeys across multiple realms", () => {
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "A", {
      _id: "A",
      nodes: { "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "s1" } }
    });
    seedJourney("prod", "2026-05-24T10-00-00Z", "bravo", "B", {
      _id: "B",
      nodes: { "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "s2" } }
    });
    const refs = indexEnv(root, "prod");
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.source.realm).sort()).toEqual(["alpha", "bravo"]);
  });
});
