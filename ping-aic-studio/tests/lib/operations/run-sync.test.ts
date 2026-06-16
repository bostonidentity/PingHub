// tests/lib/operations/run-sync.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/git", () => ({
  autoCommit: vi.fn(() => "abc1234"),
  analyzeChanges: vi.fn(() => [{ scope: "journeys", added: ["a"], modified: [], deleted: [] }]),
  pruneScopeDirs: vi.fn(() => []),
  scopeLabel: (s: string) => s,
}));
vi.mock("@/lib/op-history", () => ({ appendOpLog: vi.fn(() => ({ id: "op-1" })) }));
vi.mock("@/lib/frodo", () => ({ spawnFrodo: vi.fn(), FRODO_SCOPES: [] }));
vi.mock("@/lib/iga-api", () => ({ runIgaApi: vi.fn(), IGA_API_SCOPES: [] }));

function fakeStream(lines: string[]) {
  return new ReadableStream<string>({
    start(c) { for (const l of lines) c.enqueue(l + "\n"); c.close(); },
  });
}
const spawnFrConfig = vi.fn(() => ({
  stream: fakeStream([JSON.stringify({ type: "exit", code: 0, ts: 1 })]),
}));
vi.mock("@/lib/fr-config", async (orig) => ({
  ...(await orig()),
  getEnvFileContent: () => "CONFIG_DIR=./config\n",
  spawnFrConfig,
}));

// Import mocked modules so we can control them per-test.
import { autoCommit } from "@/lib/git";
import { appendOpLog } from "@/lib/op-history";

describe("runSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-seed defaults wiped by clearAllMocks.
    vi.mocked(autoCommit).mockReturnValue("abc1234");
    spawnFrConfig.mockReturnValue({
      stream: fakeStream([JSON.stringify({ type: "exit", code: 0, ts: 1 })]),
    });
  });

  it("returns success and emits a post-pull-commit event when the pull exits 0", async () => {
    const { runSync } = await import("@/lib/operations/run-sync");
    const events: Record<string, unknown>[] = [];
    const result = await runSync(
      { environment: "dev", scopes: ["journeys"] },
      (e) => events.push(e),
    );
    expect(result.status).toBe("success");
    expect(events.some((e) => e.action === "post-pull-commit")).toBe(true);
  });

  it("returns failed and logs failed status when the runner exits with a non-zero code", async () => {
    // Override the stream to emit exit code 1.
    spawnFrConfig.mockReturnValueOnce({
      stream: fakeStream([JSON.stringify({ type: "exit", code: 1, ts: 1 })]),
    });

    const { runSync } = await import("@/lib/operations/run-sync");
    const events: Record<string, unknown>[] = [];
    const result = await runSync(
      { environment: "dev", scopes: ["journeys"] },
      (e) => events.push(e),
    );

    expect(result.status).toBe("failed");
    expect(events.some((e) => e.action === "post-pull-commit")).toBe(false);
    expect(vi.mocked(appendOpLog)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("emits pre-pull-commit-error and returns failed without calling the runner when autoCommit throws on the pre-pull commit", async () => {
    // Make the first autoCommit call (pre-pull) throw.
    vi.mocked(autoCommit).mockImplementationOnce(() => { throw new Error("boom"); });

    const { runSync } = await import("@/lib/operations/run-sync");
    const events: Record<string, unknown>[] = [];
    const result = await runSync(
      { environment: "dev", scopes: ["journeys"] },
      (e) => events.push(e),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(events.some((e) => e.action === "pre-pull-commit-error")).toBe(true);
    expect(events.some((e) => (e as Record<string, unknown>).type === "exit")).toBe(false);
    expect(spawnFrConfig).not.toHaveBeenCalled();
  });
});
