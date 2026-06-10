import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJourneyDeps, resolveJourneyDepTree, flattenDepTree } from "./resolve-journey-deps";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinghub-resolve-deps-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function writeJourneyNode(configDir: string, journey: string, fileName: string, data: unknown): void {
  writeJson(path.join(configDir, "alpha", "journeys", journey, "nodes", fileName), data);
}

describe("resolveJourneyDeps", () => {
  it("recursively resolves subjourneys and script dependencies without duplicates", () => {
    const dir = tempDir();
    writeJson(path.join(dir, "alpha", "scripts", "scripts-config", "script-a.json"), {
      _id: "script-a",
      name: "Decision A",
    });
    writeJourneyNode(dir, "Login", "inner.json", {
      _type: { _id: "InnerTreeEvaluatorNode" },
      tree: "Child",
    });
    writeJourneyNode(dir, "Login", "script.json", {
      script: "script-a",
    });
    writeJourneyNode(dir, "Child", "script.json", {
      script: "script-a",
    });

    const deps = resolveJourneyDeps(dir, ["Login"]);

    expect(deps.subJourneys).toEqual(["Child"]);
    expect(deps.scriptUuids).toEqual(["script-a"]);
    expect(deps.scriptNames).toEqual(new Map([["script-a", "Decision A"]]));
    expect(deps.missingSubJourneys).toEqual([]);
    expect(deps.missingScriptUuids).toEqual([]);
  });

  it("reports missing subjourneys and missing script configs predictably", () => {
    const dir = tempDir();
    writeJourneyNode(dir, "Login", "inner.json", {
      _type: { _id: "InnerTreeEvaluatorNode" },
      tree: "MissingChild",
    });
    writeJourneyNode(dir, "Login", "script.json", {
      script: "missing-script",
    });

    const deps = resolveJourneyDeps(dir, ["Login"]);

    expect(deps.subJourneys).toEqual(["MissingChild"]);
    expect(deps.scriptUuids).toEqual(["missing-script"]);
    expect(deps.missingSubJourneys).toEqual(["MissingChild"]);
    expect(deps.missingScriptUuids).toEqual(["missing-script"]);
  });
});

describe("resolveJourneyDepTree", () => {
    it("builds a nested tree for a 3-level closure", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "Master", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "MFA" });
        writeJourneyNode(dir, "MFA", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Risk" });
        writeJourneyNode(dir, "Risk", "page.json", { _type: { _id: "PageNode" } });
        const tree = resolveJourneyDepTree(dir, "Master");
        expect(tree).toEqual({
            name: "Master",
            children: [{ name: "MFA", children: [{ name: "Risk", children: [] }] }],
        });
        expect(flattenDepTree(tree)).toEqual(["MFA", "Risk"]);
    });

    it("marks config cycles as repeated and stops expanding", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "A", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "B" });
        writeJourneyNode(dir, "B", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "A" });
        const tree = resolveJourneyDepTree(dir, "A");
        expect(tree.children).toEqual([
            { name: "B", children: [{ name: "A", children: [], repeated: true }] },
        ]);
        // The root journey never appears in the flat closure, repeated or not.
        expect(flattenDepTree(tree)).toEqual(["B"]);
    });

    it("marks journeys missing from config", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "Login", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Ghost" });
        const tree = resolveJourneyDepTree(dir, "Login");
        expect(tree.children).toEqual([{ name: "Ghost", children: [], missing: true }]);
        expect(flattenDepTree(tree)).toEqual([]);
    });

    it("marks a twice-referenced missing journey as missing both times", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "Root", "ij1.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Mid" });
        writeJourneyNode(dir, "Root", "ij2.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Ghost" });
        writeJourneyNode(dir, "Mid", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Ghost" });
        const tree = resolveJourneyDepTree(dir, "Root");
        const ghosts: Array<{ missing?: true; repeated?: true }> = [];
        const walk = (n: { name: string; children: typeof tree.children; missing?: true; repeated?: true }) => {
            if (n.name === "Ghost") ghosts.push({ missing: n.missing, repeated: n.repeated });
            n.children.forEach(walk);
        };
        walk(tree);
        expect(ghosts).toHaveLength(2);
        for (const g of ghosts) expect(g.missing).toBe(true);
        expect(flattenDepTree(tree)).toEqual(["Mid"]);
    });

    it("treats path-syntax journey names as missing instead of joining them", () => {
        const dir = tempDir();
        writeJourneyNode(dir, "Login", "ij.json", { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "../../../etc" });
        const tree = resolveJourneyDepTree(dir, "Login");
        expect(tree.children).toEqual([{ name: "../../../etc", children: [], missing: true }]);
        expect(flattenDepTree(tree)).toEqual([]);
        expect(resolveJourneyDepTree(dir, "../escape")).toEqual({ name: "../escape", children: [], missing: true });
    });
});
