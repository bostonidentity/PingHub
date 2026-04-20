import { describe, it, expect } from "vitest";
import { loadSemanticJourneys } from "@/lib/semantic-compare-adapter";
import fs from "fs";
import os from "os";
import path from "path";

describe("semantic-compare-adapter", () => {
  it("returns undefined when journeys not in scopes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-"));
    const r = loadSemanticJourneys(tmp, tmp, ["managed-objects"]);
    expect(r).toBeUndefined();
  });

  it("returns added/removed for journeys only on one side", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "src-"));
    const tgt = fs.mkdtempSync(path.join(os.tmpdir(), "tgt-"));
    const jDir = path.join(src, "alpha/journeys/Only");
    fs.mkdirSync(jDir, { recursive: true });
    fs.writeFileSync(path.join(jDir, "Only.json"), JSON.stringify({
      _id: "Only", entryNodeId: "n1", nodes: { n1: { nodeType: "SuccessNode", displayName: "OK" } },
    }));
    fs.writeFileSync(path.join(jDir, "n1.json"), JSON.stringify({ _id: "n1", nodeType: "SuccessNode", displayName: "OK" }));
    const r = loadSemanticJourneys(src, tgt, ["journeys"]);
    expect(r).toContainEqual(expect.objectContaining({ name: "Only", status: "removed" }));
  });

  it("returns equal when journey identical on both sides", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "src-"));
    const tgt = fs.mkdtempSync(path.join(os.tmpdir(), "tgt-"));
    for (const envDir of [src, tgt]) {
      const jDir = path.join(envDir, "alpha/journeys/Same");
      fs.mkdirSync(jDir, { recursive: true });
      fs.writeFileSync(path.join(jDir, "Same.json"), JSON.stringify({
        _id: "Same", entryNodeId: "n1", nodes: { n1: { nodeType: "SuccessNode", displayName: "OK" } },
      }));
      fs.writeFileSync(path.join(jDir, "n1.json"), JSON.stringify({ _id: "n1", nodeType: "SuccessNode", displayName: "OK" }));
    }
    const r = loadSemanticJourneys(src, tgt, ["journeys"]);
    expect(r).toContainEqual(expect.objectContaining({ name: "Same", status: "equal" }));
  });
});
