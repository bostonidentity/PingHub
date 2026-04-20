import { describe, it, expect } from "vitest";
import type {
  CanonicalScript, CanonicalNode, CanonicalJourney,
  EqualityReason, EqualityResult, NodeRefRegistry,
} from "@/lib/semantic-compare/types";

describe("semantic-compare types", () => {
  it("EqualityReason discriminated union covers all declared kinds", () => {
    const kinds: EqualityReason["kind"][] = [
      "header", "node-set", "node-settings",
      "script-missing", "script-body", "script-meta",
      "subjourney-missing", "subjourney-diff",
    ];
    expect(kinds.length).toBe(8);
  });

  it("EqualityResult carries equal + reasons", () => {
    const r: EqualityResult = { equal: true, reasons: [] };
    expect(r.equal).toBe(true);
  });

  it("NodeRefRegistry shape", () => {
    const reg: NodeRefRegistry = { ScriptedDecisionNode: { scriptRefs: ["script"] } };
    expect(reg.ScriptedDecisionNode.scriptRefs).toEqual(["script"]);
  });

  it("CanonicalScript has identity + fingerprint", () => {
    const s: CanonicalScript = {
      identity: "AUTHENTICATION_TREE_DECISION_NODE/Foo",
      context: "AUTHENTICATION_TREE_DECISION_NODE",
      name: "Foo",
      language: "JAVASCRIPT",
      evaluatorVersion: "2.0",
      defaultFlag: false,
      body: "// code",
      description: null,
    };
    expect(s.identity).toContain("/");
  });
});
