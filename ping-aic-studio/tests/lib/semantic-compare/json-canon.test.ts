import { describe, it, expect } from "vitest";
import { sortKeys, stripFields, normalizeEsvEscapes, normalizeJsonEsvEscapes, isEmptyJsonValue } from "@/lib/semantic-compare/json-canon";

describe("json-canon", () => {
  it("sortKeys sorts object keys recursively", () => {
    const input = { b: 1, a: { d: 2, c: 3 } };
    const out = sortKeys(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["a", "b"]);
    expect(Object.keys(out.a as object)).toEqual(["c", "d"]);
  });

  it("sortKeys preserves arrays in order", () => {
    const input = [3, 1, 2];
    expect(sortKeys(input)).toEqual([3, 1, 2]);
  });

  it("stripFields removes matching keys at every depth", () => {
    const input = { _id: "abc", name: "x", nested: { _id: "y", z: 1 } };
    const out = stripFields(input, ["_id"]) as Record<string, unknown>;
    expect(out._id).toBeUndefined();
    expect((out.nested as Record<string, unknown>)._id).toBeUndefined();
    expect(out.name).toBe("x");
  });

  it("normalizeEsvEscapes treats \\${foo} and ${foo} equal", () => {
    expect(normalizeEsvEscapes("\\${foo}")).toBe("${foo}");
    expect(normalizeEsvEscapes("${foo}")).toBe("${foo}");
  });

  it("normalizeJsonEsvEscapes walks every string leaf", () => {
    const input = {
      url: "https://\\${tenant}.example.com",
      arr: ["\\${a}", "plain", 42],
      nested: { key: "\\${nested}", clean: "no-esv" },
      notString: 7,
    };
    const out = normalizeJsonEsvEscapes(input) as Record<string, unknown>;
    expect(out.url).toBe("https://${tenant}.example.com");
    expect((out.arr as unknown[])[0]).toBe("${a}");
    expect((out.arr as unknown[])[1]).toBe("plain");
    expect((out.arr as unknown[])[2]).toBe(42);
    expect((out.nested as Record<string, unknown>).key).toBe("${nested}");
    expect(out.notString).toBe(7);
  });

  it("isEmptyJsonValue matches null, empty containers, and recursively-empty shapes", () => {
    expect(isEmptyJsonValue(null)).toBe(true);
    expect(isEmptyJsonValue(undefined)).toBe(true);
    expect(isEmptyJsonValue("")).toBe(true);
    expect(isEmptyJsonValue("   ")).toBe(true);
    expect(isEmptyJsonValue([])).toBe(true);
    expect(isEmptyJsonValue({})).toBe(true);
    expect(isEmptyJsonValue({ forNodes: {}, structural: [] })).toBe(true);
    expect(isEmptyJsonValue([[], {}])).toBe(true);
  });

  it("isEmptyJsonValue returns false for meaningful content", () => {
    expect(isEmptyJsonValue("x")).toBe(false);
    expect(isEmptyJsonValue(0)).toBe(false);
    expect(isEmptyJsonValue(false)).toBe(false);
    expect(isEmptyJsonValue(["a"])).toBe(false);
    expect(isEmptyJsonValue({ k: "v" })).toBe(false);
    expect(isEmptyJsonValue({ forNodes: { n1: { x: 1 } }, structural: [] })).toBe(false);
  });

  it("normalizeJsonEsvEscapes is a no-op when no ESV placeholders exist", () => {
    const input = { a: "plain", b: [1, 2], c: { d: "hi" } };
    expect(normalizeJsonEsvEscapes(input)).toEqual(input);
  });

  it("stripFields + sortKeys composes", () => {
    const input = { z: 1, _id: "x", a: { _rev: "1", b: 2 } };
    const out = sortKeys(stripFields(input, ["_id", "_rev"])) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["a", "z"]);
    expect(Object.keys(out.a as object)).toEqual(["b"]);
  });
});
