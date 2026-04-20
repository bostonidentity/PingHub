import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { buildScriptMap } from "@/lib/semantic-compare/script-map";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-map-"));
});

function writeScript(dir: string, fileName: string, cfg: Record<string, unknown>) {
  const cfgDir = path.join(dir, "alpha", "scripts", "scripts-config");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, fileName), JSON.stringify(cfg));
}

describe("buildScriptMap", () => {
  it("maps uuid -> context/name across vendored layout", () => {
    writeScript(tmpDir, "abc.json", { _id: "abc", name: "Foo", context: "CTX_A" });
    writeScript(tmpDir, "def.json", { _id: "def", name: "Bar", context: "CTX_B" });
    const m = buildScriptMap(tmpDir);
    expect(m.get("abc")).toBe("CTX_A/Foo");
    expect(m.get("def")).toBe("CTX_B/Bar");
  });

  it("also reads upstream layout realms/<r>/scripts/...", () => {
    const cfgDir = path.join(tmpDir, "realms", "alpha", "scripts", "scripts-config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "xyz.json"), JSON.stringify({ _id: "xyz", name: "X", context: "C" }));
    const m = buildScriptMap(tmpDir);
    expect(m.get("xyz")).toBe("C/X");
  });

  it("returns empty map when config dir has no scripts", () => {
    const m = buildScriptMap(tmpDir);
    expect(m.size).toBe(0);
  });

  it("skips malformed JSON without throwing", () => {
    const cfgDir = path.join(tmpDir, "alpha", "scripts", "scripts-config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "bad.json"), "not-json");
    fs.writeFileSync(path.join(cfgDir, "good.json"), JSON.stringify({ _id: "g", name: "G", context: "C" }));
    const m = buildScriptMap(tmpDir);
    expect(m.size).toBe(1);
    expect(m.get("g")).toBe("C/G");
  });
});
