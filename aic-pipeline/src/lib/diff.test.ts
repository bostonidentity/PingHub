import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport } from "./diff";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const INNER_ID = "33333333-3333-4333-8333-333333333333";
const CHILD_SCRIPT_NODE_ID = "44444444-4444-4444-8444-444444444444";
const SCRIPT_NODE_ID = "55555555-5555-4555-8555-555555555555";
const SCRIPT_ID = "66666666-6666-4666-8666-666666666666";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function makeConfig(childValue: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinghub-diff-"));
  tempDirs.push(dir);

  const journeyDir = path.join(dir, "alpha", "journeys", "Login");
  writeJson(path.join(journeyDir, "Login.json"), {
    _id: "Login",
    entryNodeId: PAGE_ID,
    nodes: {
      [PAGE_ID]: {
        nodeType: "PageNode",
        displayName: "Page",
        connections: {},
        x: 0,
        y: 0,
      },
    },
  });
  writeJson(path.join(journeyDir, "nodes", `Page_Node_-_${PAGE_ID}.json`), {
    _id: PAGE_ID,
    _type: { _id: "PageNode", name: "Page Node" },
    nodes: [{ _id: CHILD_ID, displayName: "Child", nodeType: "ValidatedCreateUsernameNode" }],
  });
  writeJson(path.join(journeyDir, "nodes", `Page_Node_-_${PAGE_ID}`, `Child_-_${CHILD_ID}.json`), {
    _id: CHILD_ID,
    _type: { _id: "ValidatedCreateUsernameNode", name: "Validated Create Username" },
    value: childValue,
  });

  return dir;
}

function makeInnerJourneyConfig(childValue: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinghub-diff-"));
  tempDirs.push(dir);

  const parentDir = path.join(dir, "alpha", "journeys", "Parent");
  writeJson(path.join(parentDir, "Parent.json"), {
    _id: "Parent",
    entryNodeId: INNER_ID,
    nodes: {
      [INNER_ID]: {
        nodeType: "InnerTreeEvaluatorNode",
        displayName: "IJ: Child",
        connections: {},
        x: 0,
        y: 0,
      },
    },
  });
  writeJson(path.join(parentDir, "nodes", `Inner_Tree_-_${INNER_ID}.json`), {
    _id: INNER_ID,
    _type: { _id: "InnerTreeEvaluatorNode", name: "Inner Tree Evaluator" },
    tree: "Child",
  });

  const childDir = path.join(dir, "alpha", "journeys", "Child");
  writeJson(path.join(childDir, "Child.json"), {
    _id: "Child",
    innerTreeOnly: true,
    entryNodeId: CHILD_SCRIPT_NODE_ID,
    nodes: {
      [CHILD_SCRIPT_NODE_ID]: {
        nodeType: "ScriptedDecisionNode",
        displayName: "Child Decision",
        connections: {},
        x: 0,
        y: 0,
      },
    },
  });
  writeJson(path.join(childDir, "nodes", `Scripted_Decision_-_${CHILD_SCRIPT_NODE_ID}.json`), {
    _id: CHILD_SCRIPT_NODE_ID,
    _type: { _id: "ScriptedDecisionNode", name: "Scripted Decision" },
    value: childValue,
  });

  return dir;
}

function makeScriptConfig(scriptContent: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinghub-diff-"));
  tempDirs.push(dir);

  const journeyDir = path.join(dir, "alpha", "journeys", "Login");
  writeJson(path.join(journeyDir, "Login.json"), {
    _id: "Login",
    entryNodeId: SCRIPT_NODE_ID,
    nodes: {
      [SCRIPT_NODE_ID]: {
        nodeType: "ScriptedDecisionNode",
        displayName: "Check Access",
        connections: {},
        x: 0,
        y: 0,
      },
    },
  });
  writeJson(path.join(journeyDir, "nodes", `Scripted_Decision_-_${SCRIPT_NODE_ID}.json`), {
    _id: SCRIPT_NODE_ID,
    _type: { _id: "ScriptedDecisionNode", name: "Scripted Decision" },
    script: SCRIPT_ID,
  });

  writeJson(path.join(dir, "alpha", "scripts", "scripts-config", `${SCRIPT_ID}.json`), {
    _id: SCRIPT_ID,
    name: "CheckAccess",
  });
  fs.mkdirSync(path.join(dir, "alpha", "scripts", "scripts-content", "Decision"), { recursive: true });
  fs.writeFileSync(path.join(dir, "alpha", "scripts", "scripts-content", "Decision", "CheckAccess.js"), scriptContent);

  return dir;
}

describe("buildReport journey tree", () => {
  it("marks nested PageNode child config changes on the journey node list", () => {
    const sourceDir = makeConfig("source");
    const targetDir = makeConfig("target");

    const report = buildReport(
      { environment: "source", mode: "local" },
      sourceDir,
      { environment: "target", mode: "local" },
      targetDir,
      ["journeys"],
    );

    const login = report.journeyTree?.find((j) => j.name === "Login");
    const page = login?.nodes.find((n) => n.uuid === PAGE_ID);
    const child = login?.nodes.find((n) => n.uuid === CHILD_ID);
    expect(page?.status).toBe("unchanged");
    expect(child?.status).toBe("modified");
  });

  it("marks an InnerTreeEvaluatorNode as modified by a changed subjourney", () => {
    const sourceDir = makeInnerJourneyConfig("source");
    const targetDir = makeInnerJourneyConfig("target");

    const report = buildReport(
      { environment: "source", mode: "local" },
      sourceDir,
      { environment: "target", mode: "local" },
      targetDir,
      ["journeys"],
    );

    const parent = report.journeyTree?.find((j) => j.name === "Parent");
    const innerNode = parent?.nodes.find((n) => n.uuid === INNER_ID);
    expect(innerNode).toMatchObject({
      status: "modified",
      modifiedReason: "subjourney",
    });
  });

  it("marks a ScriptedDecisionNode as modified by changed script content", () => {
    const sourceDir = makeScriptConfig("return false;");
    const targetDir = makeScriptConfig("return true;");

    const report = buildReport(
      { environment: "source", mode: "local" },
      sourceDir,
      { environment: "target", mode: "local" },
      targetDir,
      ["journeys", "scripts"],
    );

    const login = report.journeyTree?.find((j) => j.name === "Login");
    const scriptNode = login?.nodes.find((n) => n.uuid === SCRIPT_NODE_ID);
    expect(scriptNode).toMatchObject({
      status: "modified",
      modifiedReason: "script",
    });
  });
});
