// src/lib/semantic-compare/node-key-map.ts
export interface NodeLike {
  nodeType?: string;
  displayName?: string;
  connections?: Record<string, string>;
}

function primaryKey(n: NodeLike): string {
  return `${n.nodeType ?? "UnknownNode"}:${n.displayName ?? ""}`;
}

export function buildNodeKeyMap(journey: {
  entryNodeId?: string;
  nodes?: Record<string, NodeLike>;
}): Map<string, string> {
  const nodes = journey.nodes ?? {};
  const uuids = Object.keys(nodes);
  if (uuids.length === 0) return new Map();

  // Deterministic traversal from entryNodeId (BFS, outcomes sorted alphabetically).
  const order: string[] = [];
  const visited = new Set<string>();

  const visit = (uuid: string) => {
    if (visited.has(uuid) || !nodes[uuid]) return;
    visited.add(uuid);
    order.push(uuid);
    const cxs = nodes[uuid].connections ?? {};
    for (const outcome of Object.keys(cxs).sort()) {
      const target = cxs[outcome];
      if (target) visit(target);
    }
  };

  if (journey.entryNodeId && nodes[journey.entryNodeId]) visit(journey.entryNodeId);

  // Append any unreached nodes in (nodeType, displayName) order.
  const remaining = uuids
    .filter((u) => !visited.has(u))
    .sort((a, b) => primaryKey(nodes[a]).localeCompare(primaryKey(nodes[b])));
  for (const u of remaining) { visited.add(u); order.push(u); }

  // Assign stable keys, disambiguating collisions by traversal position.
  const counts = new Map<string, number>();
  const map = new Map<string, string>();
  for (const uuid of order) {
    const base = primaryKey(nodes[uuid]);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    map.set(uuid, n === 1 ? base : `${base}#${n}`);
  }
  return map;
}
