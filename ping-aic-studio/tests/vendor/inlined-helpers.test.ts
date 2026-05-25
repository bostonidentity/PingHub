/**
 * Unit tests for pure helpers that live inside individual vendored modules
 * (inlined from upstream utils.js / expand-source.js). These helpers aren't
 * exported publicly, so we test them via their module's exported behavior or
 * by duplicating the implementation for direct testing.
 */
import { describe, it, expect } from "vitest";

// ── safeFileName (duplicated in pull/scripts.js and pull/journeys.js) ────────
// Easier to test the shared semantic than to reach into module internals.

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

describe("safeFileName (upstream utils.js semantics)", () => {
  it("passes through ascii-safe names", () => {
    expect(safeFileName("my-file.json")).toBe("my-file.json");
    expect(safeFileName("simple_name")).toBe("simple_name");
  });

  it("replaces unsafe characters with underscore", () => {
    expect(safeFileName("foo bar")).toBe("foo_bar");
    expect(safeFileName("a/b")).toBe("a_b");
    expect(safeFileName("a:b")).toBe("a_b");
    expect(safeFileName("name with (parens)")).toBe("name_with__parens_");
  });

  it("keeps dots, dashes, underscores, alphanumerics", () => {
    expect(safeFileName("A.B-C_D.1")).toBe("A.B-C_D.1");
  });
});

// ── esvToEnv (pull/secrets.js) ──────────────────────────────────────────────

function esvToEnv(id: string): string {
  return id.replace(/-/g, "_").toUpperCase();
}

describe("esvToEnv (ESV id → env var name)", () => {
  it("upper-cases and converts dashes", () => {
    expect(esvToEnv("esv-my-secret")).toBe("ESV_MY_SECRET");
  });
  it("leaves underscores intact", () => {
    expect(esvToEnv("esv_foo")).toBe("ESV_FOO");
  });
});

// ── journeyNodeNeedsScript (pull/journeys.js, push/update-auth-trees.js) ────

function journeyNodeNeedsScript(node: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(node, "script") &&
    (!Object.prototype.hasOwnProperty.call(node, "useScript") || (node as { useScript?: boolean }).useScript === true)
  );
}

describe("journeyNodeNeedsScript", () => {
  it("returns false when node has no script property", () => {
    expect(journeyNodeNeedsScript({})).toBe(false);
    expect(journeyNodeNeedsScript({ foo: "bar" })).toBe(false);
  });

  it("returns true when node has script and no useScript flag", () => {
    expect(journeyNodeNeedsScript({ script: "uuid-123" })).toBe(true);
  });

  it("returns true when useScript=true", () => {
    expect(journeyNodeNeedsScript({ script: "uuid-123", useScript: true })).toBe(true);
  });

  it("returns false when useScript=false (opt-out)", () => {
    expect(journeyNodeNeedsScript({ script: "uuid-123", useScript: false })).toBe(false);
  });
});

// ── revertLibraryReferences (pull/custom-nodes.js) ──────────────────────────
// Load the actual module since revertLibraryReferences isn't exported.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const customNodesPull = require("../../src/vendor/fr-config-manager/pull/custom-nodes.js") as {
  pullCustomNodes: (opts: unknown) => Promise<void>;
};

describe("custom-nodes pull module", () => {
  it("exports pullCustomNodes", () => {
    expect(typeof customNodesPull.pullCustomNodes).toBe("function");
  });
});

// Instead of importing a private function, duplicate the algorithm here
// (also documents what the vendored code is expected to do).
function revertLibraryReferences(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  const importBeginRegex = /^\s*\/\/\/\s*@import-begin\s+<reference\s+path="([^"]+)"\s*\/>\s*$/;
  const importEndRegex = /^\s*\/\/\/\s*@import-end\s*$/;
  let skipping = false;

  for (const line of lines) {
    if (!skipping) {
      const match = line.match(importBeginRegex);
      if (match) {
        skipping = true;
        out.push(`/// <reference path="${match[1]}" />`);
        continue;
      }
    } else if (importEndRegex.test(line)) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

describe("revertLibraryReferences", () => {
  it("collapses @import-begin..@import-end blocks back to a single reference line", () => {
    const expanded = [
      "const x = 1;",
      `/// @import-begin <reference path="../lib/shared.js" />`,
      "function helperInjected() {}",
      "more injected code",
      `/// @import-end`,
      "const y = 2;",
    ].join("\n");

    const reverted = revertLibraryReferences(expanded);
    expect(reverted).toBe(
      [
        "const x = 1;",
        `/// <reference path="../lib/shared.js" />`,
        "const y = 2;",
      ].join("\n"),
    );
  });

  it("leaves plain source unchanged", () => {
    const src = "const x = 1;\nconst y = 2;";
    expect(revertLibraryReferences(src)).toBe(src);
  });
});

// ── escapePlaceholders (pull/service-objects.js, pull/oauth2-agents.js, …) ──

function escapePlaceholders(input: unknown): unknown {
  if (typeof input === "string") return input.replace(/\$\{/g, "\\${");
  if (Array.isArray(input)) return input.map(escapePlaceholders);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = escapePlaceholders(v);
    return out;
  }
  return input;
}

describe("escapePlaceholders", () => {
  it("escapes ${ to \\${ in strings", () => {
    expect(escapePlaceholders("hello ${WORLD}")).toBe("hello \\${WORLD}");
  });
  it("recurses into objects", () => {
    expect(escapePlaceholders({ a: "${X}", b: { c: "${Y}" } })).toEqual({ a: "\\${X}", b: { c: "\\${Y}" } });
  });
  it("recurses into arrays", () => {
    expect(escapePlaceholders(["${A}", "${B}"])).toEqual(["\\${A}", "\\${B}"]);
  });
  it("passes non-strings through", () => {
    expect(escapePlaceholders(42)).toBe(42);
    expect(escapePlaceholders(null)).toBeNull();
    expect(escapePlaceholders(true)).toBe(true);
  });
});
