import { describe, it, expect } from "vitest";
import { NODE_REFS, getRefsFor } from "@/lib/semantic-compare/node-refs";

describe("node ref registry", () => {
  it("ScriptedDecisionNode exposes script field", () => {
    expect(NODE_REFS.ScriptedDecisionNode?.scriptRefs).toContain("script");
  });

  it("ConfigProviderNode exposes script field", () => {
    expect(NODE_REFS.ConfigProviderNode?.scriptRefs).toContain("script");
  });

  it("InnerTreeEvaluatorNode exposes tree field", () => {
    expect(NODE_REFS.InnerTreeEvaluatorNode?.treeRefs).toContain("tree");
  });

  it("PageNode exposes nested node refs", () => {
    expect(NODE_REFS.PageNode?.nodeRefs).toContain("nodes");
  });

  it("unknown node types fall through to empty refs", () => {
    expect(getRefsFor("UnknownCustomNode")).toEqual({});
  });

  it("getRefsFor returns a copy, not the registry entry", () => {
    const a = getRefsFor("ScriptedDecisionNode");
    const b = getRefsFor("ScriptedDecisionNode");
    expect(a).not.toBe(b);
  });
});
