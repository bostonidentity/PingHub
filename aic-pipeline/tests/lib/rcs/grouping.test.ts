import { describe, it, expect } from "vitest";
import { buildMatrixRows, rowType } from "@/lib/rcs/grouping";
import type { Cluster, ClusterKind } from "@/lib/rcs/types";

const c = (name: string, kind: ClusterKind, connectors: string[] = []): Cluster => ({
  name,
  kind,
  members: [],
  connectors,
});

describe("rowType", () => {
  it("maps group kinds to 'Cluster'", () => {
    expect(rowType("clientGroup")).toBe("Cluster");
    expect(rowType("serverGroup")).toBe("Cluster");
  });

  it("maps instance kinds to 'Individual'", () => {
    expect(rowType("client")).toBe("Individual");
    expect(rowType("server")).toBe("Individual");
  });
});

describe("buildMatrixRows", () => {
  const envs = [
    { env: "dev", clusters: [c("rcs-cluster-external", "clientGroup", ["ad"]), c("rcs-unused", "client", [])] },
    { env: "sit", clusters: [c("rcs-cluster-external", "clientGroup", ["ad"]), c("rcs-standalone", "client", ["ldap"])] },
  ];

  it("includes Type on every row", () => {
    const rows = buildMatrixRows(envs, { groupByType: false, hideUnused: false });
    const byName = Object.fromEntries(rows.filter((r) => r.kind !== "header").map((r) => [r.name, r.type]));
    expect(byName["rcs-cluster-external"]).toBe("Cluster");
    expect(byName["rcs-standalone"]).toBe("Individual");
    expect(byName["rcs-unused"]).toBe("Individual");
  });

  it("when groupByType is on, inserts section header rows before each group", () => {
    const rows = buildMatrixRows(envs, { groupByType: true, hideUnused: false });
    expect(rows[0]).toEqual({ kind: "header", label: "RCS Clusters" });
    const nextHeaderIdx = rows.findIndex((r, i) => i > 0 && r.kind === "header");
    expect(rows[nextHeaderIdx]).toEqual({ kind: "header", label: "RCS Instances" });
    // Clusters come before Individual rows
    const firstClusterIdx = rows.findIndex((r) => r.kind !== "header" && r.type === "Cluster");
    const firstIndIdx = rows.findIndex((r) => r.kind !== "header" && r.type === "Individual");
    expect(firstClusterIdx).toBeLessThan(firstIndIdx);
  });

  it("when groupByType is off, sorts alphabetically with no headers", () => {
    const rows = buildMatrixRows(envs, { groupByType: false, hideUnused: false });
    expect(rows.some((r) => r.kind === "header")).toBe(false);
    const names = rows.filter((r) => r.kind !== "header").map((r) => r.name);
    expect(names).toEqual([...names].sort());
  });

  it("hideUnused drops Individual rows with zero connectors across every env, keeps Cluster rows", () => {
    const rows = buildMatrixRows(envs, { groupByType: true, hideUnused: true });
    const names = rows.filter((r) => r.kind !== "header").map((r) => r.name);
    expect(names).toContain("rcs-cluster-external");
    expect(names).toContain("rcs-standalone");
    expect(names).not.toContain("rcs-unused");
  });

  it("hideUnused never hides a Cluster-type row even if it has no connectors", () => {
    const envsWithEmptyCluster = [
      { env: "dev", clusters: [c("empty-cluster", "clientGroup", [])] },
    ];
    const rows = buildMatrixRows(envsWithEmptyCluster, { groupByType: true, hideUnused: true });
    expect(rows.filter((r) => r.kind !== "header").map((r) => r.name)).toEqual(["empty-cluster"]);
  });

  it("skips an empty group header when all rows of that type were hidden", () => {
    const envsAllUnused = [
      { env: "dev", clusters: [c("ind-1", "client", []), c("ind-2", "client", [])] },
    ];
    const rows = buildMatrixRows(envsAllUnused, { groupByType: true, hideUnused: true });
    expect(rows).toEqual([]);
  });
});
