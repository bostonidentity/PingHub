import { describe, it, expect } from "vitest";
import { canonicalizeNode } from "@/lib/semantic-compare/node-canon";

const stableKeyMap = new Map<string, string>([
  ["abc-uuid", "PageNode:Main"],
  ["def-uuid", "IdentityStoreDecisionNode:IDStore"],
]);
const scriptMap = new Map<string, string>([
  ["script-uuid-1", "DECISION/AllowIfAdmin"],
]);

describe("canonicalizeNode", () => {
  it("strips _id and _rev", () => {
    const out = canonicalizeNode(
      { _id: "abc-uuid", _rev: "1", nodeType: "PageNode", displayName: "Main", extra: 1 },
      "PageNode", stableKeyMap, scriptMap,
    );
    expect(out.payload._id).toBeUndefined();
    expect(out.payload._rev).toBeUndefined();
    expect(out.payload.extra).toBe(1);
  });

  it("rewrites script UUID in ScriptedDecisionNode.script", () => {
    const out = canonicalizeNode(
      { _id: "def-uuid", nodeType: "ScriptedDecisionNode", displayName: "SD", script: "script-uuid-1" },
      "ScriptedDecisionNode", stableKeyMap, scriptMap,
    );
    expect(out.payload.script).toBe("DECISION/AllowIfAdmin");
  });

  it("leaves unknown script UUID in place as <missing:uuid> marker", () => {
    const out = canonicalizeNode(
      { nodeType: "ScriptedDecisionNode", displayName: "SD", script: "unknown-uuid" },
      "ScriptedDecisionNode", stableKeyMap, scriptMap,
    );
    expect(out.payload.script).toBe("<missing:unknown-uuid>");
  });

  it("rewrites PageNode.nodes[]._id to stable keys", () => {
    const out = canonicalizeNode(
      { nodeType: "PageNode", displayName: "Page", nodes: [
        { _id: "abc-uuid", nodeType: "PageNode", displayName: "Main" },
        { _id: "def-uuid", nodeType: "IdentityStoreDecisionNode", displayName: "IDStore" },
      ]},
      "PageNode", stableKeyMap, scriptMap,
    );
    const nodes = out.payload.nodes as Array<{ _id: string }>;
    expect(nodes[0]._id).toBe("PageNode:Main");
    expect(nodes[1]._id).toBe("IdentityStoreDecisionNode:IDStore");
  });

  it("leaves InnerTreeEvaluatorNode.tree untouched", () => {
    const out = canonicalizeNode(
      { nodeType: "InnerTreeEvaluatorNode", displayName: "Inner", tree: "MySubJourney" },
      "InnerTreeEvaluatorNode", stableKeyMap, scriptMap,
    );
    expect(out.payload.tree).toBe("MySubJourney");
  });

  it("sorts keys in canonical payload", () => {
    const out = canonicalizeNode(
      { z: 1, a: 2, nodeType: "X", displayName: "Y" },
      "X", stableKeyMap, scriptMap,
    );
    const keys = Object.keys(out.payload);
    expect(keys).toEqual([...keys].sort());
  });

  it("preserves _type field (node type metadata)", () => {
    const out = canonicalizeNode(
      { nodeType: "X", displayName: "Y", _type: { _id: "X", name: "X", version: "1.0" } },
      "X", stableKeyMap, scriptMap,
    );
    expect(out.payload._type).toEqual({ _id: "X", name: "X", version: "1.0" });
  });
});
