import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadCanonicalEnv } from "@/lib/semantic-compare/loader";
import { journeysEqual } from "@/lib/semantic-compare/journey-equal";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-integration-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function writeScript(configDir: string, id: string, name: string, body: string): void {
  writeJson(path.join(configDir, "alpha", "scripts", "scripts-config", `${id}.json`), {
    _id: id,
    name,
    context: "AUTHENTICATION_TREE_DECISION_NODE",
    language: "JAVASCRIPT",
    script: { file: `scripts-content/AUTHENTICATION_TREE_DECISION_NODE/${name}.js` },
  });
  writeText(
    path.join(configDir, "alpha", "scripts", "scripts-content", "AUTHENTICATION_TREE_DECISION_NODE", `${name}.js`),
    body,
  );
}

function writeJourney(configDir: string, name: string, scriptId: string, scriptNodeValue = "outcome = 'true';"): void {
  const journeyDir = path.join(configDir, "alpha", "journeys", name);
  writeJson(path.join(journeyDir, `${name}.json`), {
    _id: name,
    entryNodeId: "script-node",
    identityResource: "managed/alpha_user",
    nodes: {
      "script-node": {
        nodeType: "ScriptedDecisionNode",
        displayName: "Check",
        connections: { true: "success" },
        x: 10,
        y: 20,
      },
      success: {
        nodeType: "SuccessNode",
        displayName: "Success",
        x: 20,
        y: 30,
      },
    },
    staticNodes: { startNode: { x: 0, y: 0 } },
  });
  writeJson(path.join(journeyDir, "nodes", "Scripted_Decision_-_script-node.json"), {
    _id: "script-node",
    _type: { _id: "ScriptedDecisionNode", name: "Scripted Decision" },
    nodeType: "ScriptedDecisionNode",
    displayName: "Check",
    script: scriptId,
    scriptInputs: {},
    scriptOutputs: {},
    _outcomes: [{ id: "true", displayName: "True" }],
    value: scriptNodeValue,
  });
  writeJson(path.join(journeyDir, "nodes", "Success_-_success.json"), {
    _id: "success",
    _type: { _id: "SuccessNode", name: "Success" },
    nodeType: "SuccessNode",
    displayName: "Success",
  });
}

describe("semantic-compare integration", () => {
  it("loads deterministic scripts and journeys from two config dirs", () => {
    const source = path.join(tmp, "source");
    const target = path.join(tmp, "target");
    writeScript(source, "script-source", "CheckScript", "outcome = 'true';\n");
    writeScript(target, "script-target", "CheckScript", "outcome = 'true';\n");
    writeJourney(source, "Login", "script-source");
    writeJourney(target, "Login", "script-target");

    const a = loadCanonicalEnv(source);
    const b = loadCanonicalEnv(target);

    expect(a.scripts.size).toBe(1);
    expect(b.scripts.size).toBe(1);
    expect(a.journeys.size).toBe(1);
    expect(b.journeys.size).toBe(1);
  });

  it("compares same-name journeys across dirs without treating stable script UUID drift as a change", () => {
    const source = path.join(tmp, "source");
    const target = path.join(tmp, "target");
    writeScript(source, "script-source", "CheckScript", "outcome = 'true';\n");
    writeScript(target, "script-target", "CheckScript", "outcome = 'true';\n");
    writeJourney(source, "Login", "script-source");
    writeJourney(target, "Login", "script-target");

    const a = loadCanonicalEnv(source);
    const b = loadCanonicalEnv(target);
    const result = journeysEqual(a.journeys.get("Login")!, b.journeys.get("Login")!, {
      scriptsA: a.scripts,
      scriptsB: b.scripts,
      journeysA: a.journeys,
      journeysB: b.journeys,
    });

    expect(result.equal).toBe(true);
  });

  it("reports a structured script reason when referenced script content changes", () => {
    const source = path.join(tmp, "source");
    const target = path.join(tmp, "target");
    writeScript(source, "script-source", "CheckScript", "outcome = 'true';\n");
    writeScript(target, "script-target", "CheckScript", "outcome = 'false';\n");
    writeJourney(source, "Login", "script-source");
    writeJourney(target, "Login", "script-target");

    const a = loadCanonicalEnv(source);
    const b = loadCanonicalEnv(target);
    const result = journeysEqual(a.journeys.get("Login")!, b.journeys.get("Login")!, {
      scriptsA: a.scripts,
      scriptsB: b.scripts,
      journeysA: a.journeys,
      journeysB: b.journeys,
    });

    expect(result.equal).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "script-body" })]),
    );
  });

  it("surfaces missing script UUIDs as missing markers instead of crashing", () => {
    const source = path.join(tmp, "source");
    writeJourney(source, "Login", "missing-script");

    const env = loadCanonicalEnv(source);
    const nodePayloads = [...env.journeys.get("Login")!.nodes.values()].map((node) => node.payload);

    expect(nodePayloads).toEqual(
      expect.arrayContaining([expect.objectContaining({ script: "<missing:missing-script>" })]),
    );
  });
});
