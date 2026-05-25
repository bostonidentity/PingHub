import { describe, it, expect } from "vitest";
import { parseEnvFile, serializeEnvFile } from "./env-parser";

describe("parseEnvFile", () => {
  it("parses simple KEY=value lines", () => {
    const out = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores comments and blank lines", () => {
    const out = parseEnvFile("# a comment\n\nKEY=value\n# trailing\n");
    expect(out).toEqual({ KEY: "value" });
  });

  it("parses single-line double-quoted values and strips quotes", () => {
    const out = parseEnvFile(`KEY="quoted value"\n`);
    expect(out.KEY).toBe("quoted value");
  });

  it("parses single-line single-quoted values and strips quotes", () => {
    const out = parseEnvFile(`KEY='quoted value'\n`);
    expect(out.KEY).toBe("quoted value");
  });

  it("parses multiline single-quoted values (PEM-style)", () => {
    const src = [
      "KEY='-----BEGIN-----",
      "line2",
      "line3-----END-----'",
      "NEXT=after",
    ].join("\n");
    const out = parseEnvFile(src);
    expect(out.KEY).toBe("-----BEGIN-----\nline2\nline3-----END-----");
    expect(out.NEXT).toBe("after");
  });

  it("unescapes \\n in legacy unquoted values", () => {
    const out = parseEnvFile("KEY=line1\\nline2\n");
    expect(out.KEY).toBe("line1\nline2");
  });

  it("ignores lines without an =", () => {
    const out = parseEnvFile("garbage\nKEY=value\n");
    expect(out).toEqual({ KEY: "value" });
  });
});

describe("serializeEnvFile", () => {
  it("serializes simple values unquoted", () => {
    const out = serializeEnvFile({ FOO: "bar", BAZ: "qux" }, "");
    expect(out).toContain("FOO=bar");
    expect(out).toContain("BAZ=qux");
  });

  it("single-quotes multiline values", () => {
    const out = serializeEnvFile({ KEY: "line1\nline2" }, "");
    expect(out).toContain("KEY='line1\nline2'");
  });

  it("preserves comments and unknown keys from the original", () => {
    const original = "# tenant notes\nOTHER=keep-me\nKEY=old\n";
    const out = serializeEnvFile({ KEY: "new" }, original);
    expect(out).toContain("KEY=new");
    expect(out).toContain("# tenant notes");
    expect(out).toContain("OTHER=keep-me");
  });

  it("round-trips a PEM-style multiline value", () => {
    const original = parseEnvFile("KEY='-----BEGIN-----\nline2\n-----END-----'\n");
    const reserialized = serializeEnvFile(original, "");
    const reparsed = parseEnvFile(reserialized);
    expect(reparsed.KEY).toBe(original.KEY);
  });

  it("skips continuation lines of known multiline values (no duplication)", () => {
    const original = "KEY='block\nline2\nblock-end'\nOTHER=keep\n";
    const out = serializeEnvFile({ KEY: "new-single" }, original);
    expect(out).toContain("KEY=new-single");
    // The old multiline continuation lines must not reappear
    expect(out).not.toContain("line2");
    expect(out).toContain("OTHER=keep");
  });
});
