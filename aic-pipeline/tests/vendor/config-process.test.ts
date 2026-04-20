import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mod = require("../../src/vendor/fr-config-manager/common/config-process.js") as {
  replaceEnvSpecificValues: (s: string, base64?: boolean, envVars?: Record<string, string | undefined>) => string;
  removeProperty: (obj: unknown, name: string) => void;
  clearOperationalAttributes: (obj: Record<string, unknown>) => void;
};
const { replaceEnvSpecificValues, removeProperty, clearOperationalAttributes } = mod;

describe("replaceEnvSpecificValues", () => {
  it("passes through strings with no placeholders", () => {
    expect(replaceEnvSpecificValues("hello world", false, {})).toBe("hello world");
  });

  it("substitutes a single placeholder", () => {
    expect(replaceEnvSpecificValues("value=${FOO}", false, { FOO: "bar" })).toBe("value=bar");
  });

  it("substitutes multiple placeholders", () => {
    expect(
      replaceEnvSpecificValues("${A}-${B}-${C}", false, { A: "1", B: "2", C: "3" }),
    ).toBe("1-2-3");
  });

  it("throws when an env var is unset", () => {
    expect(() => replaceEnvSpecificValues("${MISSING}", false, {})).toThrow(/MISSING/);
  });

  it("base64-encodes when base64Encode=true", () => {
    const result = replaceEnvSpecificValues("${V}", true, { V: "secret" });
    expect(result).toBe(Buffer.from("secret").toString("base64"));
  });

  it("honors BASE64: prefix by skipping re-encode", () => {
    const pre = Buffer.from("raw").toString("base64");
    const result = replaceEnvSpecificValues("${BASE64:RAW}", true, { RAW: pre });
    // BASE64: prefix forces encode=false, so the already-encoded value passes through.
    expect(result).toBe(pre);
  });

  it("skips substitution when placeholder has double-backslash prefix", () => {
    // Two backslashes before ${ tell the function not to substitute — matches
    // upstream behavior. The unescape pass then collapses `\\${` back to `\${`.
    const input = "x=\\\\${NOT_A_VAR}";
    const output = replaceEnvSpecificValues(input, false, {});
    // No throw (would happen if substitution was attempted), and the placeholder
    // text survives (after one-level unescape of `\\${` → `\${`).
    expect(output).toContain("${NOT_A_VAR}");
  });
});

describe("removeProperty", () => {
  it("deletes a top-level property", () => {
    const o: Record<string, unknown> = { a: 1, b: 2 };
    removeProperty(o, "b");
    expect(o).toEqual({ a: 1 });
  });

  it("deletes deeply nested properties", () => {
    const o: Record<string, unknown> = { a: { b: { c: 1, skip: 2 } }, skip: 3 };
    removeProperty(o, "skip");
    expect(o).toEqual({ a: { b: { c: 1 } } });
  });

  it("leaves arrays traversed but does not splice", () => {
    const o: Record<string, unknown> = { list: [{ skip: 1, keep: 2 }, { skip: 3, keep: 4 }] };
    removeProperty(o, "skip");
    expect(o).toEqual({ list: [{ keep: 2 }, { keep: 4 }] });
  });
});

describe("clearOperationalAttributes", () => {
  it("strips standard IDM operational fields", () => {
    const o: Record<string, unknown> = {
      _id: "x",
      _rev: "y",
      _pushApiVersion: { protocol: "1.0" },
      createdBy: "a",
      creationDate: "2026",
      lastModifiedBy: "b",
      lastModifiedDate: "2026",
      name: "keep",
    };
    clearOperationalAttributes(o);
    expect(o).toEqual({ name: "keep" });
  });
});
