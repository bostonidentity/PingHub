import { describe, it, expect, vi, beforeEach } from "vitest";

const runGit = vi.fn();
vi.mock("@/lib/git-settings", () => ({
  loadSettings: () => ({ targetDir: "/repo", branch: "main", remoteUrl: "git@x:y.git" }),
  resolveTargetDir: () => "/repo",
  targetHasGit: () => true,
  runGit: (...a: unknown[]) => runGit(...a),
}));
vi.mock("@/lib/op-history", () => ({ appendOpLog: vi.fn(() => ({ id: "op-2" })) }));

describe("runGitPush", () => {
  beforeEach(() => { runGit.mockReset(); });

  it("commits and pushes when the repo is dirty", async () => {
    runGit
      .mockReturnValueOnce({ code: 0, stdout: " M a\n", stderr: "" }) // status
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" })        // add
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" })        // commit
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" });       // push
    const { runGitPush } = await import("@/lib/operations/run-git-push");
    const result = await runGitPush({ message: "scheduled sync" }, () => {});
    expect(result.status).toBe("success");
    const argvs = runGit.mock.calls.map((c) => (c[0] as string[]).join(" "));
    expect(argvs.some((a) => a.startsWith("commit"))).toBe(true);
    expect(argvs.some((a) => a.startsWith("push"))).toBe(true);
  });

  it("returns success without committing when the tree is clean", async () => {
    runGit
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" })  // status clean
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" }); // push
    const { runGitPush } = await import("@/lib/operations/run-git-push");
    const result = await runGitPush({ message: "noop" }, () => {});
    expect(result.status).toBe("success");
    const argvs = runGit.mock.calls.map((c) => (c[0] as string[]).join(" "));
    expect(argvs.some((a) => a.startsWith("commit"))).toBe(false);
  });
});
