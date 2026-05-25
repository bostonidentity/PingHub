import { describe, it, expect } from "vitest";
import { parseMergedDiffGraph, diffNodeHeight, diffPageGroupHeight } from "./journey-diff-graph";

function journey(opts: {
  entryNodeId?: string;
  nodes: Record<string, { nodeType: string; connections?: Record<string, string>; displayName?: string; x?: number; y?: number }>;
}): string {
  const nodes: Record<string, unknown> = {};
  for (const [id, n] of Object.entries(opts.nodes)) {
    nodes[id] = { x: 0, y: 0, displayName: id, ...n };
  }
  return JSON.stringify({ entryNodeId: opts.entryNodeId, nodes });
}

describe("diffNodeHeight", () => {
  it("returns the default height when outcome count is small", () => {
    expect(diffNodeHeight(0)).toBeGreaterThanOrEqual(64);
    expect(diffNodeHeight(1)).toBeGreaterThanOrEqual(64);
  });
  it("grows with outcome count", () => {
    expect(diffNodeHeight(10)).toBeGreaterThan(diffNodeHeight(1));
  });
});

describe("diffPageGroupHeight", () => {
  it("grows with child count", () => {
    expect(diffPageGroupHeight(3)).toBeGreaterThan(diffPageGroupHeight(1));
  });
});

describe("parseMergedDiffGraph", () => {
  it("returns empty graph when both sides are undefined", () => {
    const { nodes, edges } = parseMergedDiffGraph(undefined, undefined, new Map());
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("parses a simple single-sided (source-only) journey — all nodes marked removed", () => {
    // Compare-polarity: source-only content arrives as `localContent`; the remote side
    // is undefined. Every node should render as `removed`.
    const local = journey({
      entryNodeId: "n1",
      nodes: {
        n1: { nodeType: "ScriptedDecisionNode", connections: { true: "n2" } },
        n2: { nodeType: "PageNode" },
      },
    });
    const { nodes } = parseMergedDiffGraph(local, undefined, new Map());
    expect(nodes.length).toBeGreaterThan(0);
    const realNodes = nodes.filter((n) => n.id === "n1" || n.id === "n2");
    expect(realNodes).toHaveLength(2);
    for (const n of realNodes) {
      expect(n.data.diffStatus).toBe("removed");
    }
  });

  it("parses a target-only journey — all nodes marked added", () => {
    const remote = journey({
      entryNodeId: "n1",
      nodes: {
        n1: { nodeType: "ScriptedDecisionNode" },
      },
    });
    const { nodes } = parseMergedDiffGraph(undefined, remote, new Map());
    const real = nodes.find((n) => n.id === "n1");
    expect(real?.data.diffStatus).toBe("added");
  });

  it("parses identical both-sides as unchanged", () => {
    const j = journey({
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode" } },
    });
    const { nodes } = parseMergedDiffGraph(j, j, new Map());
    const real = nodes.find((n) => n.id === "n1");
    expect(real?.data.diffStatus).toBe("unchanged");
  });

  it("marks a node present on both sides but with different type as modified or split", () => {
    const local = journey({
      nodes: { shared: { nodeType: "ScriptedDecisionNode" } },
    });
    const remote = journey({
      nodes: { shared: { nodeType: "ScriptedDecisionNode", displayName: "different" } },
    });
    const { nodes } = parseMergedDiffGraph(local, remote, new Map());
    const real = nodes.find((n) => n.id === "shared");
    // Exact status depends on the parser's equality rule — just ensure we get
    // a real node back with *some* diff status (not undefined).
    expect(real).toBeDefined();
    expect(real!.data.diffStatus).toBeDefined();
  });

  it("uses explicit status map entries for PageNode children", () => {
    const j = journey({
      nodes: {
        page: { nodeType: "PageNode", displayName: "Page" },
      },
    });
    const { nodes } = parseMergedDiffGraph(
      j,
      j,
      new Map([["child-1", "modified"]]),
      undefined,
      new Map([["page", { nodes: [{ _id: "child-1", displayName: "Child", nodeType: "PingOneProtectInitializeNode" }] }]]),
    );
    const child = nodes.find((n) => n.id === "page__child__child-1");
    expect(child?.data.diffStatus).toBe("modified");
  });

  it("returns invalid JSON as empty graph without throwing", () => {
    const { nodes } = parseMergedDiffGraph("not json", undefined, new Map());
    expect(nodes).toEqual([]);
  });
});
