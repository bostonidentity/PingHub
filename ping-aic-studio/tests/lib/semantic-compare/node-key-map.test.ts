import { describe, it, expect } from "vitest";
import { buildNodeKeyMap } from "@/lib/semantic-compare/node-key-map";

const journey = {
  entryNodeId: "A",
  nodes: {
    A: { nodeType: "PageNode", displayName: "Page", connections: { outcome: "B" } },
    B: { nodeType: "IdentityStoreDecisionNode", displayName: "IDStore", connections: { TRUE: "C", FALSE: "D" } },
    C: { nodeType: "AccountLockoutNode", displayName: "Lock" },
    D: { nodeType: "AccountLockoutNode", displayName: "Lock" },   // collision — same type+name
    E: { nodeType: "OrphanNode", displayName: "Orphan" },          // disconnected
  },
};

describe("buildNodeKeyMap", () => {
  it("assigns primary key nodeType:displayName", () => {
    const m = buildNodeKeyMap(journey);
    expect(m.get("A")).toBe("PageNode:Page");
    expect(m.get("B")).toBe("IdentityStoreDecisionNode:IDStore");
  });

  it("disambiguates collisions by traversal order with #N suffix", () => {
    const m = buildNodeKeyMap(journey);
    // BFS from A visits A → B → (outcomes of B sorted alphabetically: FALSE, TRUE)
    // so D (via FALSE) is visited before C (via TRUE). D gets base key, C gets #2.
    expect(m.get("D")).toBe("AccountLockoutNode:Lock");
    expect(m.get("C")).toBe("AccountLockoutNode:Lock#2");
  });

  it("disconnected nodes get appended in (nodeType, displayName) order", () => {
    const m = buildNodeKeyMap(journey);
    expect(m.get("E")).toBe("OrphanNode:Orphan");
  });

  it("handles missing entryNodeId by iterating nodes in name order", () => {
    const flat = {
      nodes: {
        Z: { nodeType: "X", displayName: "Z" },
        A: { nodeType: "X", displayName: "A" },
      },
    };
    const m = buildNodeKeyMap(flat);
    expect(m.get("A")).toBe("X:A");
    expect(m.get("Z")).toBe("X:Z");
  });

  it("returns empty map when nodes is missing", () => {
    expect(buildNodeKeyMap({}).size).toBe(0);
  });
});
