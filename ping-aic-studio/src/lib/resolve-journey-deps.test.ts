import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJourneyDeps } from "./resolve-journey-deps";

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
