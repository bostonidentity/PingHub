import { describe, expect, it } from "vitest";
import { findKeywordMatchRows, logEntryMatchKey } from "./log-match-navigation";

describe("log-match-navigation", () => {
  it("finds keyword matches consistently across consecutive rows", () => {
    const rows = [
      { key: "a", line: "first ERROR line" },
      { key: "b", line: "second ERROR line" },
      { key: "c", line: "plain line" },
    ];

    expect(findKeywordMatchRows(rows, ["error"], { matchCase: false, wholeWord: false })).toEqual([
      { key: "a", index: 0 },
      { key: "b", index: 1 },
    ]);
  });

  it("supports whole-word and case-sensitive matching", () => {
    const rows = [
      { key: "a", line: "token auth failed" },
      { key: "b", line: "tokenize should not match whole word" },
      { key: "c", line: "Token case differs" },
    ];

    expect(findKeywordMatchRows(rows, ["token"], { matchCase: true, wholeWord: true })).toEqual([
      { key: "a", index: 0 },
    ]);
  });

  it("uses stable entry fields in match keys", () => {
    const key = logEntryMatchKey({
      timestamp: "2026-04-24T12:00:00Z",
      source: "am-core",
      type: "text/plain",
      payload: "message",
    }, 4);

    expect(key).toContain("2026-04-24T12:00:00Z");
    expect(key).toContain("am-core");
    expect(key).toContain("message");
  });

  it("keeps an existing match identifiable when later matching rows are appended", () => {
    const firstKey = "first";
    const before = findKeywordMatchRows([
      { key: firstKey, line: "ERROR one" },
    ], ["error"], { matchCase: false, wholeWord: false });
    const after = findKeywordMatchRows([
      { key: firstKey, line: "ERROR one" },
      { key: "second", line: "ERROR two" },
    ], ["error"], { matchCase: false, wholeWord: false });

    expect(before[0].key).toBe(firstKey);
    expect(after.findIndex((row) => row.key === firstKey)).toBe(0);
  });
});
