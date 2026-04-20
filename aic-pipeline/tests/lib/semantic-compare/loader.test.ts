import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadCanonicalEnv } from "@/lib/semantic-compare/loader";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loader-"));
});

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe("loadCanonicalEnv", () => {
  it("loads scripts + journeys from vendored layout", () => {
    // Script
    write(path.join(tmp, "alpha/scripts/scripts-config/s1.json"), JSON.stringify({
      _id: "s1", name: "Foo", context: "CTX", language: "JAVASCRIPT",
      script: { file: "scripts-content/CTX/Foo.js" },
    }));
    write(path.join(tmp, "alpha/scripts/scripts-content/CTX/Foo.js"), "return 1;");

    // Journey
    write(path.join(tmp, "alpha/journeys/MyJ/MyJ.json"), JSON.stringify({
      _id: "MyJ", entryNodeId: "n1", identityResource: "managed/alpha_user",
      nodes: { n1: { nodeType: "SuccessNode", displayName: "OK" } },
      staticNodes: { startNode: { x: 0, y: 0 } },
    }));
    write(path.join(tmp, "alpha/journeys/MyJ/n1.json"), JSON.stringify({
      _id: "n1", nodeType: "SuccessNode", displayName: "OK",
    }));

    const env = loadCanonicalEnv(tmp);
    expect(env.scripts.get("CTX/Foo")?.body).toBe("return 1;\n");
    expect(env.journeys.get("MyJ")?.nodes.size).toBe(1);
    expect(env.journeys.get("MyJ")?.header.entryNodeId).toBe("SuccessNode:OK");
  });

  it("gracefully skips journeys with no main file", () => {
    fs.mkdirSync(path.join(tmp, "alpha/journeys/broken"), { recursive: true });
    const env = loadCanonicalEnv(tmp);
    expect(env.journeys.size).toBe(0);
  });

  it("returns empty maps when config dir is empty", () => {
    const env = loadCanonicalEnv(tmp);
    expect(env.scripts.size).toBe(0);
    expect(env.journeys.size).toBe(0);
  });
});
