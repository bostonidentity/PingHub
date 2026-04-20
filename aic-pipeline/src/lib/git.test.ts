import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub op-history so git.ts can resolve the history git root without touching
// the filesystem. Tests that need a real git cwd override this per-test.
vi.mock("./op-history", () => ({
  getHistoryGitRoot: vi.fn(() => null),
  buildTrailers: (m: { operation: string; environment: string }) =>
    `Operation: ${m.operation}\nEnvironment: ${m.environment}`,
}));

// Control execSync so we can drive git.ts branches from tests.
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({ execSync: (...args: unknown[]) => execSyncMock(...args) }));
vi.mock("child_process", () => ({ execSync: (...args: unknown[]) => execSyncMock(...args) }));

beforeEach(() => {
  execSyncMock.mockReset();
});

describe("scopeLabel", () => {
  it("returns the known label for a mapped scope", async () => {
    const { scopeLabel } = await import("./git");
    expect(scopeLabel("journeys")).toBe("Journeys");
    expect(scopeLabel("scripts")).toBe("Scripts");
    expect(scopeLabel("idm-authentication")).toBe("IDM Authentication");
  });

  it("falls back to a Title Case version of the raw scope for unknown values", async () => {
    const { scopeLabel } = await import("./git");
    expect(scopeLabel("something-new")).toBe("Something New");
  });
});

describe("hasChanges", () => {
  it("returns false when the nested env git repo is not initialized", async () => {
    // getHistoryGitRoot returns null by default → hasChanges should short-circuit.
    const { hasChanges } = await import("./git");
    expect(hasChanges("ide3")).toBe(false);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("returns true when git status reports modified files", async () => {
    vi.doMock("./op-history", () => ({
      getHistoryGitRoot: vi.fn(() => "/fake/envs"),
      buildTrailers: (m: { operation: string; environment: string }) =>
        `Operation: ${m.operation}\nEnvironment: ${m.environment}`,
    }));
    vi.resetModules();
    execSyncMock.mockReturnValue(" M ide3/config/ide3/realms/alpha/journeys/foo/foo.json\n");
    const { hasChanges } = await import("./git");
    expect(hasChanges("ide3")).toBe(true);
    expect(execSyncMock).toHaveBeenCalled();
  });

  it("returns false when git status is empty", async () => {
    vi.doMock("./op-history", () => ({
      getHistoryGitRoot: vi.fn(() => "/fake/envs"),
      buildTrailers: (m: { operation: string; environment: string }) =>
        `Operation: ${m.operation}\nEnvironment: ${m.environment}`,
    }));
    vi.resetModules();
    execSyncMock.mockReturnValue("");
    const { hasChanges } = await import("./git");
    expect(hasChanges("ide3")).toBe(false);
  });
});

describe("getScopePruneTargets", () => {
  it("returns the global scope dir for a known scope", async () => {
    const { getScopePruneTargets } = await import("./git");
    const targets = getScopePruneTargets("/tmp/fake-config", "audit");
    expect(targets.some((t) => t.endsWith("/audit"))).toBe(true);
  });

  it("returns an empty list for an unknown scope", async () => {
    const { getScopePruneTargets } = await import("./git");
    const targets = getScopePruneTargets("/tmp/fake-config", "no-such-scope");
    expect(targets).toEqual([]);
  });
});
