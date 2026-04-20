import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Stub git-settings so op-history doesn't try to probe a real repo.
vi.mock("./git-settings", () => ({
  loadSettings: () => ({ targetDir: "environments", branch: "main", remoteUrl: "" }),
  resolveTargetDir: () => "/nonexistent",
  targetHasGit: () => false,
}));

// op-history reads process.cwd() at import time for OP_LOG_PATH; point it at a
// fresh temp dir for each test run.
let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "op-history-test-"));
  fs.mkdirSync(path.join(tmpRoot, "environments"), { recursive: true });
  process.chdir(tmpRoot);
  vi.resetModules(); // re-evaluate module so OP_LOG_PATH picks up new cwd
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./op-history");
}

describe("buildTrailers", () => {
  it("emits a minimal trailer block with just operation + environment", async () => {
    const { buildTrailers } = await loadModule();
    const out = buildTrailers({ operation: "pull", environment: "ide3" });
    expect(out).toBe("Operation: pull\nEnvironment: ide3");
  });

  it("emits all optional fields when provided", async () => {
    const { buildTrailers } = await loadModule();
    const out = buildTrailers({
      operation: "pull",
      environment: "ide3",
      scopes: ["journeys", "scripts"],
      status: "success",
      startedAt: "2026-04-12T14:00:00.000Z",
      durationMs: 13434,
      added: 3,
      modified: 7,
      deleted: 1,
    });
    expect(out).toContain("Operation: pull");
    expect(out).toContain("Environment: ide3");
    expect(out).toContain("Scopes: journeys,scripts");
    expect(out).toContain("Status: success");
    expect(out).toContain("Started-At: 2026-04-12T14:00:00.000Z");
    expect(out).toContain("Duration-ms: 13434");
    expect(out).toContain("Changed: +3 ~7 -1");
  });

  it("omits Scopes line when scopes is empty", async () => {
    const { buildTrailers } = await loadModule();
    const out = buildTrailers({ operation: "pull", environment: "ide3", scopes: [] });
    expect(out).not.toContain("Scopes:");
  });

  it("emits Changed line even when all counts are zero (if any is set)", async () => {
    const { buildTrailers } = await loadModule();
    const out = buildTrailers({
      operation: "pull",
      environment: "ide3",
      added: 0,
      modified: 0,
      deleted: 0,
    });
    expect(out).toContain("Changed: +0 ~0 -0");
  });
});

describe("appendOpLog + readOpLog", () => {
  it("appends a JSONL record with generated id, completedAt, kind='op'", async () => {
    const { appendOpLog, readOpLog } = await loadModule();
    const rec = appendOpLog({
      type: "push",
      environment: "ide3",
      scopes: ["journeys"],
      status: "success",
      startedAt: "2026-04-12T14:00:00.000Z",
      durationMs: 500,
      summary: "1 item",
    });
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.kind).toBe("op");
    expect(rec.commitHash).toBeNull();
    expect(rec.completedAt).toBeTruthy();

    const all = readOpLog();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(rec.id);
  });

  it("returns records in reverse-chronological order (newest first)", async () => {
    const { appendOpLog, readOpLog } = await loadModule();
    appendOpLog({
      type: "push", environment: "ide3", scopes: [], status: "success",
      startedAt: "2026-04-12T14:00:00.000Z", durationMs: 0, summary: "first",
    });
    appendOpLog({
      type: "push", environment: "ide3", scopes: [], status: "success",
      startedAt: "2026-04-12T14:00:01.000Z", durationMs: 0, summary: "second",
    });
    const all = readOpLog();
    expect(all[0].summary).toBe("second");
    expect(all[1].summary).toBe("first");
  });

  it("filters by environment and type", async () => {
    const { appendOpLog, readOpLog } = await loadModule();
    appendOpLog({ type: "push", environment: "dev", scopes: [], status: "success", startedAt: "2026-04-12T14:00:00.000Z", durationMs: 0, summary: "a" });
    appendOpLog({ type: "push", environment: "ide3", scopes: [], status: "success", startedAt: "2026-04-12T14:00:01.000Z", durationMs: 0, summary: "b" });
    appendOpLog({ type: "compare", environment: "ide3", scopes: [], status: "success", startedAt: "2026-04-12T14:00:02.000Z", durationMs: 0, summary: "c" });

    expect(readOpLog({ environment: "ide3" })).toHaveLength(2);
    expect(readOpLog({ type: "compare" })).toHaveLength(1);
    expect(readOpLog({ environment: "ide3", type: "push" })).toHaveLength(1);
  });

  it("matches source/target environment for compare records via filter", async () => {
    const { appendOpLog, readOpLog } = await loadModule();
    appendOpLog({
      type: "compare",
      environment: "sandbox1 → ide3",
      scopes: [],
      status: "success",
      startedAt: "2026-04-12T14:00:00.000Z",
      durationMs: 0,
      summary: "ok",
      source: { environment: "sandbox1", mode: "local" },
      target: { environment: "ide3", mode: "remote" },
    });
    expect(readOpLog({ environment: "sandbox1" })).toHaveLength(1);
    expect(readOpLog({ environment: "ide3" })).toHaveLength(1);
    expect(readOpLog({ environment: "nope" })).toHaveLength(0);
  });
});

describe("rotateOpLog", () => {
  it("trims the op log to the 500-entry cap", async () => {
    const { appendOpLog, readOpLog } = await loadModule();
    // Write 503 entries — should trim down to 500 (newest kept).
    for (let i = 0; i < 503; i++) {
      appendOpLog({
        type: "push",
        environment: "ide3",
        scopes: [],
        status: "success",
        startedAt: new Date(Date.UTC(2026, 3, 12, 14, 0, 0, i)).toISOString(),
        durationMs: 0,
        summary: `n${i}`,
      });
    }
    const all = readOpLog();
    expect(all).toHaveLength(500);
    // Oldest three should have been dropped.
    expect(all.some((r) => r.summary === "n0")).toBe(false);
    expect(all.some((r) => r.summary === "n2")).toBe(false);
    expect(all.some((r) => r.summary === "n502")).toBe(true);
  });
});

describe("readHistoryEntry", () => {
  it("finds an op-log entry by id", async () => {
    const { appendOpLog, readHistoryEntry } = await loadModule();
    const rec = appendOpLog({
      type: "push", environment: "ide3", scopes: [], status: "success",
      startedAt: "2026-04-12T14:00:00.000Z", durationMs: 0, summary: "x",
    });
    const found = readHistoryEntry(rec.id);
    expect(found?.id).toBe(rec.id);
  });

  it("returns null for an unknown id", async () => {
    const { readHistoryEntry } = await loadModule();
    expect(readHistoryEntry("not-a-real-id")).toBeNull();
  });
});
