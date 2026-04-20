import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "git-settings-test-"));
  process.chdir(tmpRoot);
  // Force a fresh module load so SETTINGS_PATH picks up the new cwd.
  const { vi } = await import("vitest");
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./git-settings");
}

describe("loadSettings", () => {
  it("returns defaults when no settings file exists", async () => {
    const { loadSettings } = await loadModule();
    const s = loadSettings();
    expect(s.branch).toBe("main");
    expect(s.targetDir).toBe("environments");
    expect(s.autoPush).toBe(false);
    expect(s.remoteUrl).toBe("");
    expect(s.commitTemplate).toContain("{op}");
  });

  it("merges saved fields over defaults", async () => {
    const { saveSettings, loadSettings } = await loadModule();
    saveSettings({ remoteUrl: "git@example.com:org/repo.git", branch: "master" });
    const s = loadSettings();
    expect(s.remoteUrl).toBe("git@example.com:org/repo.git");
    expect(s.branch).toBe("master");
    // Untouched default still present
    expect(s.targetDir).toBe("environments");
  });

  it("returns defaults when the settings file is malformed", async () => {
    fs.writeFileSync(path.join(tmpRoot, "git-settings.json"), "not json");
    const { loadSettings } = await loadModule();
    const s = loadSettings();
    expect(s.branch).toBe("main");
  });
});

describe("saveSettings", () => {
  it("writes a JSON file to <cwd>/git-settings.json", async () => {
    const { saveSettings } = await loadModule();
    saveSettings({ remoteUrl: "https://example.com/repo.git" });
    const raw = fs.readFileSync(path.join(tmpRoot, "git-settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.remoteUrl).toBe("https://example.com/repo.git");
    expect(parsed.branch).toBe("main"); // default merged in
  });
});

describe("resolveTargetDir", () => {
  it("returns an absolute path when targetDir is relative", async () => {
    const { resolveTargetDir } = await loadModule();
    const abs = resolveTargetDir({
      remoteUrl: "", branch: "main", targetDir: "environments",
      authorName: "", authorEmail: "", autoPush: false, commitTemplate: "",
    });
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs.endsWith("environments")).toBe(true);
  });

  it("returns the targetDir unchanged when it is already absolute", async () => {
    const { resolveTargetDir } = await loadModule();
    const absIn = "/tmp/abs-target";
    const abs = resolveTargetDir({
      remoteUrl: "", branch: "main", targetDir: absIn,
      authorName: "", authorEmail: "", autoPush: false, commitTemplate: "",
    });
    expect(abs).toBe(absIn);
  });
});

describe("targetHasGit", () => {
  it("returns false when the target dir has no .git folder", async () => {
    const { targetHasGit, saveSettings } = await loadModule();
    saveSettings({ targetDir: "environments" });
    fs.mkdirSync(path.join(tmpRoot, "environments"), { recursive: true });
    expect(targetHasGit()).toBe(false);
  });

  it("returns true when the target dir has a .git folder", async () => {
    const { targetHasGit, saveSettings } = await loadModule();
    saveSettings({ targetDir: "environments" });
    fs.mkdirSync(path.join(tmpRoot, "environments", ".git"), { recursive: true });
    expect(targetHasGit()).toBe(true);
  });
});
