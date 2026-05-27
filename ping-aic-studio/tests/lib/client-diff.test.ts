import { describe, expect, it } from "vitest";
import {
    clientDiff,
    formatForDiff,
    summarizeDiff,
    toSplitRows,
} from "@/lib/client-diff";

describe("clientDiff", () => {
    it("returns a single context block when inputs are identical", () => {
        const lines = clientDiff("a\nb\nc", "a\nb\nc");
        expect(lines).toEqual([
            { type: "context", content: "a" },
            { type: "context", content: "b" },
            { type: "context", content: "c" },
        ]);
    });

    it("handles two empty inputs", () => {
        expect(clientDiff("", "")).toEqual([]);
    });

    it("classifies pure additions", () => {
        const lines = clientDiff("", "a\nb");
        expect(lines).toEqual([
            { type: "added", content: "a" },
            { type: "added", content: "b" },
        ]);
    });

    it("classifies pure removals", () => {
        const lines = clientDiff("a\nb", "");
        expect(lines).toEqual([
            { type: "removed", content: "a" },
            { type: "removed", content: "b" },
        ]);
    });

    it("detects a single-line modification as remove+add around context", () => {
        const lines = clientDiff("a\nb\nc", "a\nB\nc");
        const types = lines.map((l) => l.type);
        expect(types).toContain("removed");
        expect(types).toContain("added");
        expect(lines[0]).toEqual({ type: "context", content: "a" });
        expect(lines.at(-1)).toEqual({ type: "context", content: "c" });
        const removed = lines.find((l) => l.type === "removed");
        const added = lines.find((l) => l.type === "added");
        expect(removed?.content).toBe("b");
        expect(added?.content).toBe("B");
    });

    it("guards against pathological input sizes", () => {
        const big = "x\n".repeat(60_000);
        const result = clientDiff(big, "");
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe("context");
        expect(result[0].content).toMatch(/too large/);
    });
});

describe("summarizeDiff", () => {
    it("counts each line type", () => {
        const summary = summarizeDiff([
            { type: "context", content: "x" },
            { type: "added", content: "a" },
            { type: "added", content: "b" },
            { type: "removed", content: "r" },
        ]);
        expect(summary).toEqual({ added: 2, removed: 1, context: 1 });
    });
});

describe("formatForDiff", () => {
    it("pretty-prints JSON content regardless of file extension", () => {
        const out = formatForDiff('{"b":1,"a":2}', "snippet.txt");
        expect(out).toBe('{\n  "b": 1,\n  "a": 2\n}');
    });

    it("beautifies JS by extension", () => {
        const out = formatForDiff("function f(){return 1}", "x.js");
        expect(out).toContain("function f()");
        expect(out).toContain("return 1");
        expect(out.endsWith("\n")).toBe(true);
    });

    it("returns non-JSON, non-script content untouched", () => {
        expect(formatForDiff("plain text", "notes.txt")).toBe("plain text");
    });
});

describe("toSplitRows", () => {
    it("returns no rows for an empty diff", () => {
        expect(toSplitRows([])).toEqual([]);
    });

    it("emits paired context rows that show identical content in both columns", () => {
        const rows = toSplitRows([
            { type: "context", content: "a" },
            { type: "context", content: "b" },
        ]);
        expect(rows).toEqual([
            { left: "a", leftRem: false, right: "a", rightAdd: false },
            { left: "b", leftRem: false, right: "b", rightAdd: false },
        ]);
    });

    it("pairs equal-length removed and added blocks side by side", () => {
        const rows = toSplitRows([
            { type: "removed", content: "x" },
            { type: "added", content: "X" },
        ]);
        expect(rows).toEqual([
            { left: "x", leftRem: true, right: "X", rightAdd: true },
        ]);
    });

    it("pairs unequal blocks with null spillover on the shorter side", () => {
        const rows = toSplitRows([
            { type: "removed", content: "a" },
            { type: "removed", content: "b" },
            { type: "added", content: "X" },
        ]);
        expect(rows).toEqual([
            { left: "a", leftRem: true, right: "X", rightAdd: true },
            { left: "b", leftRem: true, right: null, rightAdd: false },
        ]);
    });

    it("handles a hunk where added precedes removed", () => {
        const rows = toSplitRows([
            { type: "added", content: "X" },
            { type: "added", content: "Y" },
            { type: "removed", content: "a" },
        ]);
        expect(rows).toEqual([
            { left: "a", leftRem: true, right: "X", rightAdd: true },
            { left: null, leftRem: false, right: "Y", rightAdd: true },
        ]);
    });

    it("alternates context and change hunks correctly", () => {
        const rows = toSplitRows([
            { type: "context", content: "h1" },
            { type: "removed", content: "old" },
            { type: "added", content: "new" },
            { type: "context", content: "h2" },
        ]);
        expect(rows).toEqual([
            { left: "h1", leftRem: false, right: "h1", rightAdd: false },
            { left: "old", leftRem: true, right: "new", rightAdd: true },
            { left: "h2", leftRem: false, right: "h2", rightAdd: false },
        ]);
    });

    it("matches the Compare tab on a realistic script-style diff", () => {
        const a = "function greet(name) {\n  console.log('hi ' + name);\n}";
        const b = "function greet(name) {\n  console.log(`hi ${name}`);\n}";
        const rows = toSplitRows(clientDiff(a, b));
        // Three rows: opening context, paired change, closing context
        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({
            left: "function greet(name) {",
            leftRem: false,
            right: "function greet(name) {",
            rightAdd: false,
        });
        expect(rows[1].leftRem).toBe(true);
        expect(rows[1].rightAdd).toBe(true);
        expect(rows[1].left).toBe("  console.log('hi ' + name);");
        expect(rows[1].right).toBe("  console.log(`hi ${name}`);");
        expect(rows[2]).toEqual({
            left: "}",
            leftRem: false,
            right: "}",
            rightAdd: false,
        });
    });
});
