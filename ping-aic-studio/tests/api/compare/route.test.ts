import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CompareReport } from "@/lib/diff-types";

const mocks = vi.hoisted(() => ({
  spawnFrConfig: vi.fn(),
  getConfigDir: vi.fn(),
  getEnvFileContent: vi.fn(),
  buildReport: vi.fn(),
  appendOpLog: vi.fn(),
  resolveJourneyDeps: vi.fn(),
  getRealmRoots: vi.fn(),
  runEsvPrecheckOnReport: vi.fn(),
}));

vi.mock("@/lib/fr-config", () => ({
  spawnFrConfig: mocks.spawnFrConfig,
  getConfigDir: mocks.getConfigDir,
  getEnvFileContent: mocks.getEnvFileContent,
}));

vi.mock("@/lib/diff", () => ({
  buildReport: mocks.buildReport,
}));

vi.mock("@/lib/op-history", () => ({
  appendOpLog: mocks.appendOpLog,
}));

vi.mock("@/lib/resolve-journey-deps", () => ({
  resolveJourneyDeps: mocks.resolveJourneyDeps,
}));

vi.mock("@/lib/realm-paths", () => ({
  getRealmRoots: mocks.getRealmRoots,
}));

vi.mock("@/lib/analyze/promote-precheck", () => ({
  runEsvPrecheckOnReport: mocks.runEsvPrecheckOnReport,
}));

import { POST } from "@/app/api/compare/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/compare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readNdjson(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function report(files: CompareReport["files"], extra: Partial<CompareReport> = {}): CompareReport {
  const summary = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const file of files) summary[file.status]++;
  return {
    source: { environment: "source", mode: "local" },
    target: { environment: "target", mode: "local" },
    generatedAt: "2026-04-24T00:00:00.000Z",
    options: { includeMetadata: false, ignoreWhitespace: true },
    summary,
    files,
    ...extra,
  };
}

function ndjsonStream(events: Array<Record<string, unknown>>): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const event of events) controller.enqueue(`${JSON.stringify(event)}\n`);
      controller.close();
    },
  });
}

describe("POST /api/compare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigDir.mockImplementation((env: string) => `/configs/${env}`);
    mocks.getEnvFileContent.mockReturnValue("");
    mocks.resolveJourneyDeps.mockReturnValue({
      subJourneys: [],
      scriptUuids: [],
      scriptNames: new Map<string, string>(),
    });
    mocks.getRealmRoots.mockReturnValue([]);
    mocks.runEsvPrecheckOnReport.mockResolvedValue({ missing: [] });
  });

  it("streams a report for a local-local compare and records history", async () => {
    const baseReport = report([
      { relativePath: "alpha/journeys/Login/Login.json", status: "modified" },
    ]);
    mocks.buildReport.mockReturnValue(baseReport);

    const res = await POST(makeRequest({
      source: { environment: "source", mode: "local" },
      target: { environment: "target", mode: "local" },
      scopes: ["journeys"],
    }));
    const events = await readNdjson(res);
    const reportEvent = events.find((event) => event.type === "report");

    expect(res.status).toBe(200);
    expect(mocks.buildReport).toHaveBeenCalledWith(
      { environment: "source", mode: "local" },
      "/configs/source",
      { environment: "target", mode: "local" },
      "/configs/target",
      ["journeys"],
      undefined,
      expect.any(Set),
    );
    expect(reportEvent).toBeDefined();
    expect(JSON.parse(reportEvent!.data as string)).toMatchObject({
      summary: { added: 0, removed: 0, modified: 1, unchanged: 0 },
      files: [{ relativePath: "alpha/journeys/Login/Login.json", status: "modified" }],
    });
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
    expect(mocks.appendOpLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "compare",
      environment: "source → target",
      status: "success",
    }));
  });

  it("flips added and removed polarity for dry-run reports", async () => {
    mocks.buildReport.mockReturnValue(report(
      [
        {
          relativePath: "alpha/journeys/SourceOnly/SourceOnly.json",
          status: "removed",
          localContent: "source-only",
          linesAdded: 0,
          linesRemoved: 1,
          diffLines: [{ type: "removed", content: "source-only" }],
        },
        {
          relativePath: "alpha/journeys/TargetOnly/TargetOnly.json",
          status: "added",
          remoteContent: "target-only",
          linesAdded: 1,
          linesRemoved: 0,
          diffLines: [{ type: "added", content: "target-only" }],
        },
      ],
      {
        journeyTree: [
          { name: "AddedToTarget", status: "removed", isEntry: true, subJourneys: [], scripts: [], nodes: [] },
          { name: "RemovedFromTarget", status: "added", isEntry: true, subJourneys: [], scripts: [], nodes: [] },
        ],
      },
    ));
    mocks.runEsvPrecheckOnReport.mockResolvedValue({ missing: ["esv-missing"] });

    const res = await POST(makeRequest({
      source: { environment: "source", mode: "local" },
      target: { environment: "target", mode: "local" },
      scopes: ["journeys"],
      mode: "dry-run",
    }));
    const events = await readNdjson(res);
    const reportEvent = events.find((event) => event.type === "report");
    const data = JSON.parse(reportEvent!.data as string) as CompareReport;

    expect(data.summary).toMatchObject({ added: 1, removed: 1 });
    expect(data.files[0]).toMatchObject({
      status: "added",
      remoteContent: "source-only",
      linesAdded: 1,
      linesRemoved: 0,
      diffLines: [{ type: "added", content: "source-only" }],
    });
    expect(data.files[1]).toMatchObject({
      status: "removed",
      localContent: "target-only",
      linesAdded: 0,
      linesRemoved: 1,
      diffLines: [{ type: "removed", content: "target-only" }],
    });
    expect(data.journeyTree?.map((node) => [node.name, node.status])).toEqual([
      ["AddedToTarget", "added"],
      ["RemovedFromTarget", "removed"],
    ]);
    expect(data.esvPrecheck).toEqual({ missing: ["esv-missing"] });
    expect(mocks.appendOpLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "dry-run",
      status: "success",
    }));
  });

  it("expands selected journey dependencies and filters files by parsed scope", async () => {
    mocks.resolveJourneyDeps.mockReturnValue({
      subJourneys: ["ChildJourney"],
      scriptUuids: ["script-1"],
      scriptNames: new Map([["script-1", "ScriptOne"]]),
    });
    mocks.buildReport.mockReturnValue(report([
      { relativePath: "alpha/journeys/Login/Login.json", status: "modified" },
      { relativePath: "alpha/journeys/ChildJourney/ChildJourney.json", status: "modified" },
      { relativePath: "alpha/scripts/scripts-config/script-1.json", status: "modified" },
      { relativePath: "alpha/scripts/scripts-content/AUTHENTICATION_TREE_DECISION_NODE/ScriptOne.js", status: "modified" },
      // Same item text as the journey, different scope. This must not leak through.
      { relativePath: "endpoints/Login/Login.js", status: "modified" },
    ]));

    const res = await POST(makeRequest({
      source: { environment: "source", mode: "local" },
      target: { environment: "target", mode: "local" },
      scopeSelections: [{ scope: "journeys", items: ["Login"] }],
      includeDeps: false,
    }));
    const events = await readNdjson(res);
    const reportEvent = events.find((event) => event.type === "report");
    const data = JSON.parse(reportEvent!.data as string) as CompareReport;

    expect(mocks.resolveJourneyDeps).toHaveBeenCalledWith("/configs/source", ["Login"]);
    expect(mocks.buildReport.mock.calls[0][4]).toEqual(["journeys", "scripts"]);
    expect([...(mocks.buildReport.mock.calls[0][6] as Set<string>)]).toEqual(["Login", "ChildJourney"]);
    expect(data.files.map((file) => file.relativePath)).toEqual([
      "alpha/journeys/Login/Login.json",
      "alpha/journeys/ChildJourney/ChildJourney.json",
      "alpha/scripts/scripts-config/script-1.json",
      "alpha/scripts/scripts-content/AUTHENTICATION_TREE_DECISION_NODE/ScriptOne.js",
    ]);
    expect(data.summary).toEqual({ added: 0, removed: 0, modified: 4, unchanged: 0 });
    expect(data.missingDeps).toEqual({
      missingJourneys: ["ChildJourney"],
      missingScripts: ["ScriptOne"],
    });
  });

  it("pulls remote endpoints and forwards pull stream events with side labels", async () => {
    mocks.spawnFrConfig
      .mockReturnValueOnce({
        abort: vi.fn(),
        stream: ndjsonStream([
          { type: "stdout", data: "source pull\n", ts: 1 },
          { type: "exit", code: 0, ts: 2 },
        ]),
      })
      .mockReturnValueOnce({
        abort: vi.fn(),
        stream: ndjsonStream([
          { type: "stdout", data: "target pull\n", ts: 3 },
          { type: "exit", code: 0, ts: 4 },
        ]),
      });
    mocks.buildReport.mockReturnValue(report([]));

    const res = await POST(makeRequest({
      source: { environment: "source", mode: "remote" },
      target: { environment: "target", mode: "remote" },
      scopes: ["journeys"],
    }));
    const events = await readNdjson(res);

    expect(mocks.spawnFrConfig).toHaveBeenCalledTimes(2);
    expect(mocks.spawnFrConfig).toHaveBeenNthCalledWith(1, expect.objectContaining({
      command: "fr-config-pull",
      environment: "source",
      scopes: ["journeys"],
      envOverrides: { CONFIG_DIR: expect.stringContaining("fr-compare-") },
    }));
    expect(mocks.spawnFrConfig).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: "fr-config-pull",
      environment: "target",
      scopes: ["journeys"],
      envOverrides: { CONFIG_DIR: expect.stringContaining("fr-compare-") },
    }));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "stdout", data: "source pull\n", side: "source" }),
        expect.objectContaining({ type: "stdout", data: "target pull\n", side: "target" }),
        expect.objectContaining({ type: "report" }),
        expect.objectContaining({ type: "exit", code: 0 }),
      ]),
    );
  });
});
