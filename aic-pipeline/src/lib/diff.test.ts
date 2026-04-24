import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport } from "./diff";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";

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
    const child = login?.nodes.find((n) => n.uuid === CHILD_ID);
    expect(child?.status).toBe("modified");
  });
});
