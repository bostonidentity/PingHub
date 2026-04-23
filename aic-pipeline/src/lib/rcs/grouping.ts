import type { Cluster, ClusterKind } from "./types";

export type RowType = "Cluster" | "Individual";

export interface EnvClusters {
  env: string;
  clusters: Cluster[];
}

export type MatrixRow =
  | { kind: "header"; label: string }
  | { kind: "cluster"; name: string; type: RowType; rowKind: ClusterKind };

export interface BuildOpts {
  groupByType: boolean;
  hideUnused: boolean;
}

export function rowType(kind: ClusterKind): RowType {
  return kind === "clientGroup" || kind === "serverGroup" ? "Cluster" : "Individual";
}

export function buildMatrixRows(envs: EnvClusters[], opts: BuildOpts): MatrixRow[] {
  const byName = new Map<string, { kind: ClusterKind; totalConnectors: number }>();
  for (const e of envs) {
    for (const c of e.clusters) {
      const prev = byName.get(c.name);
      const totalConnectors = (prev?.totalConnectors ?? 0) + c.connectors.length;
      byName.set(c.name, { kind: prev?.kind ?? c.kind, totalConnectors });
    }
  }

  let entries = Array.from(byName.entries()).map(([name, v]) => ({
    name,
    type: rowType(v.kind),
    rowKind: v.kind,
    totalConnectors: v.totalConnectors,
  }));

  if (opts.hideUnused) {
    entries = entries.filter((e) => e.type === "Cluster" || e.totalConnectors > 0);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (!opts.groupByType) {
    return entries.map(({ name, type, rowKind }) => ({ kind: "cluster" as const, name, type, rowKind }));
  }

  const clusters = entries.filter((e) => e.type === "Cluster");
  const individuals = entries.filter((e) => e.type === "Individual");
  const out: MatrixRow[] = [];
  if (clusters.length > 0) {
    out.push({ kind: "header", label: "RCS Clusters" });
    for (const e of clusters) out.push({ kind: "cluster", name: e.name, type: e.type, rowKind: e.rowKind });
  }
  if (individuals.length > 0) {
    out.push({ kind: "header", label: "RCS Instances" });
    for (const e of individuals) out.push({ kind: "cluster", name: e.name, type: e.type, rowKind: e.rowKind });
  }
  return out;
}
