import { describe, it, expect } from "vitest";
import type { CanonicalScript } from "@/lib/semantic-compare/types";
import { scriptsEqual } from "@/lib/semantic-compare/script-equal";

const base: CanonicalScript = {
  identity: "CTX/Foo", context: "CTX", name: "Foo",
  language: "JAVASCRIPT", evaluatorVersion: "2.0",
  defaultFlag: false, body: "return 1;\n", description: null,
};

describe("scriptsEqual", () => {
  it("identical scripts are equal", () => {
    const r = scriptsEqual(base, { ...base });
    expect(r.equal).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("body diff reported as script-body reason", () => {
    const r = scriptsEqual(base, { ...base, body: "return 2;\n" });
    expect(r.equal).toBe(false);
    expect(r.reasons).toContainEqual({ kind: "script-body", identity: "CTX/Foo" });
  });

  it("language change reported as script-meta", () => {
    const r = scriptsEqual(base, { ...base, language: "GROOVY" });
    expect(r.equal).toBe(false);
    const meta = r.reasons.find((x) => x.kind === "script-meta");
    expect(meta).toMatchObject({ kind: "script-meta", identity: "CTX/Foo", fields: ["language"] });
  });

  it("evaluatorVersion + defaultFlag changes both land in script-meta", () => {
    const r = scriptsEqual(base, { ...base, evaluatorVersion: "1.0", defaultFlag: true });
    const meta = r.reasons.find((x) => x.kind === "script-meta");
    expect(meta).toMatchObject({
      kind: "script-meta",
      fields: expect.arrayContaining(["evaluatorVersion", "defaultFlag"]),
    });
  });

  it("description changes do NOT break equality", () => {
    const r = scriptsEqual(base, { ...base, description: "hello" });
    expect(r.equal).toBe(true);
  });
});
