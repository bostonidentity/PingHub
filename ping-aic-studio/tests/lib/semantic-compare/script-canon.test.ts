import { describe, it, expect } from "vitest";
import {
  canonicalizeScript, scriptIdentity, normalizeScriptBody,
} from "@/lib/semantic-compare/script-canon";

const baseConfig = {
  _id: "abc-uuid",
  _rev: "123",
  name: "Foo",
  context: "AUTHENTICATION_TREE_DECISION_NODE",
  description: "null",
  language: "JAVASCRIPT",
  evaluatorVersion: "2.0",
  default: false,
  script: { file: "scripts-content/AUTHENTICATION_TREE_DECISION_NODE/Foo.js" },
  createdBy: "id=x", creationDate: 1,
  lastModifiedBy: "id=x", lastModifiedDate: 2,
};

describe("script-canon", () => {
  it("scriptIdentity yields context/name", () => {
    expect(scriptIdentity(baseConfig)).toBe("AUTHENTICATION_TREE_DECISION_NODE/Foo");
  });

  it("canonicalizeScript strips env-local fields", () => {
    const body = "return true;\n";
    const s = canonicalizeScript(baseConfig, body);
    expect(s.identity).toBe("AUTHENTICATION_TREE_DECISION_NODE/Foo");
    expect(s.language).toBe("JAVASCRIPT");
    expect(s.evaluatorVersion).toBe("2.0");
    expect(s.defaultFlag).toBe(false);
    expect(s.body).toBe("return true;\n");
    expect((s as unknown as Record<string, unknown>)._id).toBeUndefined();
  });

  it("normalizeScriptBody handles CRLF, trailing whitespace, BOM, final newline", () => {
    const raw = "\uFEFFconst a = 1;   \r\nconst b = 2;";
    expect(normalizeScriptBody(raw)).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("normalizeScriptBody keeps empty string empty", () => {
    expect(normalizeScriptBody("")).toBe("");
  });

  it("normalizeScriptBody collapses vendored-pull ESV escape artifacts", () => {
    expect(normalizeScriptBody('var x = "\\${tenant}";')).toBe('var x = "${tenant}";\n');
    // Upstream (unescaped) form must round-trip unchanged.
    expect(normalizeScriptBody('var x = "${tenant}";')).toBe('var x = "${tenant}";\n');
  });

  it("description defaults to null for 'null' string", () => {
    const s = canonicalizeScript(baseConfig, "");
    expect(s.description).toBe(null);
  });
});
