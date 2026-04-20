import { describe, it, expect } from "vitest";
import { canonicalizeJourney } from "@/lib/semantic-compare/journey-canon";

const treeJson = {
  _id: "MyJourney",
  _rev: "xyz",
  identityResource: "managed/alpha_user",
  entryNodeId: "A",
  innerTreeOnly: false,
  enabled: true,
  description: "Login",
  uiConfig: { annotations: "{}", categories: "[\"Auth\"]" },
  nodes: {
    A: { nodeType: "PageNode", displayName: "Page", connections: { outcome: "B" }, x: 1, y: 2 },
    B: { nodeType: "ScriptedDecisionNode", displayName: "SD", connections: { "TRUE": "C" } },
    C: { nodeType: "SuccessNode", displayName: "OK" },
  },
  staticNodes: { startNode: { x: 0, y: 0 }, end: { x: 99, y: 99 } },
};

const nodeFiles: Record<string, Record<string, unknown>> = {
  A: { _id: "A", nodeType: "PageNode", displayName: "Page" },
  B: { _id: "B", nodeType: "ScriptedDecisionNode", displayName: "SD", script: "script-uuid-1" },
  C: { _id: "C", nodeType: "SuccessNode", displayName: "OK" },
};

const scriptMap = new Map([["script-uuid-1", "DECISION/AllowIfAdmin"]]);

describe("canonicalizeJourney", () => {
  it("sets journey name from directory name, not _id", () => {
    const c = canonicalizeJourney("my-journey", treeJson, nodeFiles, scriptMap);
    expect(c.name).toBe("my-journey");
  });

  it("strips cosmetic fields and metadata from header", () => {
    const c = canonicalizeJourney("my-journey", treeJson, nodeFiles, scriptMap);
    expect(c.header._id).toBeUndefined();
    expect(c.header._rev).toBeUndefined();
    expect(c.header.uiConfig).toEqual({ categories: "[\"Auth\"]" });
    // entryNodeId rewritten to stable key
    expect(c.header.entryNodeId).toBe("PageNode:Page");
  });

  it("rewrites wiring inside nodes map to stable keys", () => {
    const c = canonicalizeJourney("my-journey", treeJson, nodeFiles, scriptMap);
    const headerNodes = c.header.nodes as Record<string, { connections?: Record<string, string> }>;
    expect(headerNodes["PageNode:Page"].connections).toEqual({ outcome: "ScriptedDecisionNode:SD" });
  });

  it("drops node x/y coordinates", () => {
    const c = canonicalizeJourney("my-journey", treeJson, nodeFiles, scriptMap);
    const headerNodes = c.header.nodes as Record<string, unknown>;
    expect(JSON.stringify(headerNodes)).not.toContain("\"x\":");
  });

  it("populates nodes map with canonical node payloads", () => {
    const c = canonicalizeJourney("my-journey", treeJson, nodeFiles, scriptMap);
    expect(c.nodes.get("PageNode:Page")).toBeDefined();
    expect(c.nodes.get("ScriptedDecisionNode:SD")?.payload.script).toBe("DECISION/AllowIfAdmin");
  });

  it("collects referenced scripts and sub-journeys", () => {
    const withInner = {
      ...treeJson,
      nodes: {
        ...treeJson.nodes,
        D: { nodeType: "InnerTreeEvaluatorNode", displayName: "Inner", connections: {} },
      },
    };
    const withInnerNodeFiles = {
      ...nodeFiles,
      D: { _id: "D", nodeType: "InnerTreeEvaluatorNode", displayName: "Inner", tree: "SubJ" },
    };
    const c = canonicalizeJourney("my-journey", withInner, withInnerNodeFiles, scriptMap);
    expect(c.referencedScripts.has("DECISION/AllowIfAdmin")).toBe(true);
    expect(c.referencedSubJourneys.has("SubJ")).toBe(true);
  });

  it("staticNodeKeys captures the set without coords", () => {
    const c = canonicalizeJourney("my-journey", treeJson, nodeFiles, scriptMap);
    expect(c.staticNodeKeys.has("startNode")).toBe(true);
    expect(c.staticNodeKeys.has("end")).toBe(true);
  });

  it("drops uiConfig fields whose stringified JSON parses to an empty value", () => {
    const tree = {
      ...treeJson,
      uiConfig: { categories: "[]", annotations: "{\"forNodes\":{},\"structural\":[]}" },
    };
    const c = canonicalizeJourney("my-journey", tree, nodeFiles, scriptMap);
    // annotations is always stripped; categories: "[]" is an empty-equivalent,
    // so the whole uiConfig object collapses and gets dropped from the header.
    expect(c.header.uiConfig).toBeUndefined();
  });

  it("keeps uiConfig.categories when it carries real content", () => {
    const tree = {
      ...treeJson,
      uiConfig: { categories: "[\"Authentication\"]" },
    };
    const c = canonicalizeJourney("my-journey", tree, nodeFiles, scriptMap);
    expect(c.header.uiConfig).toEqual({ categories: "[\"Authentication\"]" });
  });

  it("journey with `{ categories: '[]' }` equals journey with `{}` via canonical header", () => {
    const a = canonicalizeJourney("same", { ...treeJson, uiConfig: { categories: "[]" } }, nodeFiles, scriptMap);
    const b = canonicalizeJourney("same", { ...treeJson, uiConfig: { annotations: "{\"forNodes\":{},\"structural\":[]}" } }, nodeFiles, scriptMap);
    expect(JSON.stringify(a.header)).toBe(JSON.stringify(b.header));
  });
});
