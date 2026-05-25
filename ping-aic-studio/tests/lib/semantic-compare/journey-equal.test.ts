import { describe, it, expect } from "vitest";
import type { CanonicalJourney, CanonicalScript } from "@/lib/semantic-compare/types";
import { journeysEqual } from "@/lib/semantic-compare/journey-equal";

function mkJourney(overrides: Partial<CanonicalJourney> = {}): CanonicalJourney {
  return {
    name: "J",
    header: { identityResource: "managed/alpha_user", enabled: true },
    nodes: new Map([["PageNode:Page", {
      stableKey: "PageNode:Page", nodeType: "PageNode", displayName: "Page",
      payload: { nodeType: "PageNode" },
    }]]),
    staticNodeKeys: new Set(["startNode"]),
    referencedScripts: new Set(),
    referencedSubJourneys: new Set(),
    ...overrides,
  };
}

function mkScript(identity: string, body = ""): CanonicalScript {
  const [context, name] = identity.split("/");
  return { identity, context, name, language: "JAVASCRIPT", evaluatorVersion: "2.0", defaultFlag: false, body, description: null };
}

describe("journeysEqual (single level, no recursion)", () => {
  it("identical canonical journeys are equal", () => {
    const r = journeysEqual(mkJourney(), mkJourney(), { scriptsA: new Map(), scriptsB: new Map() });
    expect(r.equal).toBe(true);
  });

  it("header difference reported", () => {
    const a = mkJourney();
    const b = mkJourney({ header: { identityResource: "managed/alpha_user", enabled: false } });
    const r = journeysEqual(a, b, { scriptsA: new Map(), scriptsB: new Map() });
    expect(r.equal).toBe(false);
    expect(r.reasons.find((x) => x.kind === "header")).toBeDefined();
  });

  it("different node sets reported as node-set", () => {
    const a = mkJourney();
    const b = mkJourney({
      nodes: new Map([["AccountLockoutNode:Lock", {
        stableKey: "AccountLockoutNode:Lock", nodeType: "AccountLockoutNode", displayName: "Lock",
        payload: {},
      }]]),
    });
    const r = journeysEqual(a, b, { scriptsA: new Map(), scriptsB: new Map() });
    const reason = r.reasons.find((x) => x.kind === "node-set");
    expect(reason).toMatchObject({ kind: "node-set", added: ["AccountLockoutNode:Lock"], removed: ["PageNode:Page"] });
  });

  it("same keys different payload reported as node-settings", () => {
    const a = mkJourney();
    const b = mkJourney({
      nodes: new Map([["PageNode:Page", {
        stableKey: "PageNode:Page", nodeType: "PageNode", displayName: "Page",
        payload: { nodeType: "PageNode", newField: 1 },
      }]]),
    });
    const r = journeysEqual(a, b, { scriptsA: new Map(), scriptsB: new Map() });
    expect(r.reasons).toContainEqual(expect.objectContaining({ kind: "node-settings", stableKey: "PageNode:Page" }));
  });

  it("referenced script missing on one side flagged", () => {
    const a = mkJourney({ referencedScripts: new Set(["CTX/Missing"]) });
    const b = mkJourney({ referencedScripts: new Set(["CTX/Missing"]) });
    const r = journeysEqual(a, b, {
      scriptsA: new Map([["CTX/Missing", mkScript("CTX/Missing", "body")]]),
      scriptsB: new Map(),
    });
    expect(r.reasons).toContainEqual({ kind: "script-missing", identity: "CTX/Missing", side: "target" });
  });

  it("referenced script body differs flagged as script-body", () => {
    const a = mkJourney({ referencedScripts: new Set(["CTX/S"]) });
    const b = mkJourney({ referencedScripts: new Set(["CTX/S"]) });
    const r = journeysEqual(a, b, {
      scriptsA: new Map([["CTX/S", mkScript("CTX/S", "a\n")]]),
      scriptsB: new Map([["CTX/S", mkScript("CTX/S", "b\n")]]),
    });
    expect(r.reasons).toContainEqual({ kind: "script-body", identity: "CTX/S" });
  });
});

describe("journeysEqual recursion", () => {
  it("recurses into inner journeys when resolvers provided", () => {
    const sub = mkJourney({
      name: "Sub",
      header: { identityResource: "managed/alpha_user", enabled: true },
    });
    const subChanged = mkJourney({
      name: "Sub",
      header: { identityResource: "managed/alpha_user", enabled: false },
    });
    const outer  = mkJourney({ name: "Outer", referencedSubJourneys: new Set(["Sub"]) });
    const outer2 = mkJourney({ name: "Outer", referencedSubJourneys: new Set(["Sub"]) });
    const r = journeysEqual(outer, outer2, {
      scriptsA: new Map(), scriptsB: new Map(),
      journeysA: new Map([["Sub", sub]]),
      journeysB: new Map([["Sub", subChanged]]),
    });
    expect(r.reasons).toContainEqual(expect.objectContaining({
      kind: "subjourney-diff",
      name: "Sub",
    }));
  });

  it("flags missing inner journey", () => {
    const outer = mkJourney({ referencedSubJourneys: new Set(["Missing"]) });
    const r = journeysEqual(outer, outer, {
      scriptsA: new Map(), scriptsB: new Map(),
      journeysA: new Map([["Missing", mkJourney({ name: "Missing" })]]),
      journeysB: new Map(),
    });
    expect(r.reasons).toContainEqual({ kind: "subjourney-missing", name: "Missing", side: "target" });
  });

  it("handles cycles gracefully (self-reference)", () => {
    const self = mkJourney({ name: "Self", referencedSubJourneys: new Set(["Self"]) });
    const r = journeysEqual(self, self, {
      scriptsA: new Map(), scriptsB: new Map(),
      journeysA: new Map([["Self", self]]),
      journeysB: new Map([["Self", self]]),
    });
    expect(r.equal).toBe(true);
  });
});
