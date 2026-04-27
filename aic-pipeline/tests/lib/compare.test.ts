import { describe, it, expect } from "vitest";
import { summarizeReport } from "@/lib/compare";
import type { CompareReport, FileDiff } from "@/lib/diff-types";

function mkReport(files: FileDiff[]): CompareReport {
  return {
    source: { environment: "repo", mode: "local" },
    target: { environment: "dev", mode: "remote" },
    generatedAt: new Date().toISOString(),
    summary: { added: 0, removed: 0, modified: 0, unchanged: 0 },
    files,
  };
}

function mkFile(scope: string, status: FileDiff["status"], name = `${scope}/x`): FileDiff {
  return {
    scope,
    status,
    relativePath: name,
  };
}

describe("summarizeReport", () => {
  it("returns empty array when no files changed", () => {
    const report = mkReport([mkFile("journeys", "unchanged"), mkFile("scripts", "unchanged")]);
    expect(summarizeReport(report)).toEqual([]);
  });

  it("groups files by scope and counts added/modified/removed", () => {
    const report = mkReport([
      mkFile("journeys", "added", "journeys/a"),
      mkFile("journeys", "added", "journeys/b"),
      mkFile("journeys", "modified", "journeys/c"),
      mkFile("scripts", "modified", "scripts/s1"),
      mkFile("scripts", "removed", "scripts/s2"),
    ]);
    const result = summarizeReport(report);
    expect(result).toEqual([
      { scope: "journeys", added: 2, modified: 1, removed: 0 },
      { scope: "scripts",  added: 0, modified: 1, removed: 1 },
    ]);
  });

  it("drops scopes that only have unchanged files", () => {
    const report = mkReport([
      mkFile("journeys", "unchanged"),
      mkFile("scripts", "modified"),
    ]);
    const result = summarizeReport(report);
    expect(result).toEqual([
      { scope: "scripts", added: 0, modified: 1, removed: 0 },
    ]);
  });

  it("derives scope from relativePath when scope field is absent", () => {
    const report = mkReport([
      { relativePath: "journeys/Login.json", status: "modified" },
      { relativePath: "scripts/foo.js", status: "added" },
      { relativePath: "scripts/bar.js", status: "removed" },
    ]);
    const result = summarizeReport(report);
    expect(result).toEqual([
      { scope: "journeys", added: 0, modified: 1, removed: 0 },
      { scope: "scripts",  added: 1, modified: 0, removed: 1 },
    ]);
  });
});
