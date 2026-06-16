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

describe("runSync", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
