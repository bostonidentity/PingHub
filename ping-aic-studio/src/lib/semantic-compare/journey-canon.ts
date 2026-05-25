import type { CanonicalJourney, CanonicalNode } from "./types";
import { sortKeys, stripFields, normalizeJsonEsvEscapes, isEmptyJsonValue } from "./json-canon";
import { buildNodeKeyMap, type NodeLike } from "./node-key-map";
import { canonicalizeNode } from "./node-canon";

const STRIP_TOP = ["_id", "_rev"];
const STRIP_DEEP = ["createdBy", "creationDate", "lastModifiedBy", "lastModifiedDate", "lastChangeDate", "lastChangedBy"];

export function canonicalizeJourney(
  name: string,
  treeJson: Record<string, unknown>,
  nodeFiles: Record<string, Record<string, unknown>>,
  scriptMap: Map<string, string>,
): CanonicalJourney {
  const nodeKeyMap = buildNodeKeyMap(treeJson as { nodes?: Record<string, NodeLike>; entryNodeId?: string });

  // Canonicalize each node file.
  const nodes = new Map<string, CanonicalNode>();
  const referencedScripts = new Set<string>();
  const referencedSubJourneys = new Set<string>();

  for (const [uuid, raw] of Object.entries(nodeFiles)) {
    const nodeType = String(raw.nodeType ?? (treeJson.nodes as Record<string, { nodeType?: string }>)?.[uuid]?.nodeType ?? "UnknownNode");
    const cn = canonicalizeNode(raw, nodeType, nodeKeyMap, scriptMap);
    nodes.set(cn.stableKey, cn);

    if (nodeType === "ScriptedDecisionNode" || nodeType === "ConfigProviderNode" || nodeType === "ConfigProviderNodeV2") {
      const id = cn.payload.script;
      if (typeof id === "string" && !id.startsWith("<missing:")) referencedScripts.add(id);
    }
    if (nodeType === "InnerTreeEvaluatorNode") {
      const t = cn.payload.tree;
      if (typeof t === "string") referencedSubJourneys.add(t);
    }
  }

  // Build canonical header.
  // Shallow strip of _id/_rev at the top level only; deep strip for audit metadata.
  const stripped: Record<string, unknown> = { ...treeJson };
  for (const f of STRIP_TOP) delete stripped[f];
  const deepStripped = stripFields(stripped, STRIP_DEEP) as Record<string, unknown>;

  // Normalize uiConfig.
  // `annotations` (canvas sticky notes) is always cosmetic — strip it.
  // For remaining fields (notably `categories`), the ForgeRock exporter stores
  // stringified JSON like `"[]"` or `"{\"forNodes\":{},\"structural\":[]}"`.
  // When that string parses to an empty container, treat it as equivalent to
  // the field being absent — otherwise `{ categories: "[]" }` on one side and
  // `{}` on the other triggers a spurious "header: uiConfig" reason even when
  // the two journeys are semantically identical. If uiConfig ends up empty,
  // drop it entirely so it doesn't differ from an absent uiConfig.
  if (deepStripped.uiConfig && typeof deepStripped.uiConfig === "object") {
    const ui = { ...(deepStripped.uiConfig as Record<string, unknown>) };
    delete ui.annotations;
    for (const [k, v] of Object.entries(ui)) {
      if (typeof v !== "string") continue;
      try {
        if (isEmptyJsonValue(JSON.parse(v))) delete ui[k];
      } catch { /* not JSON — keep as-is */ }
    }
    if (Object.keys(ui).length === 0) delete deepStripped.uiConfig;
    else deepStripped.uiConfig = ui;
  }

  // Rewrite entryNodeId
  if (typeof deepStripped.entryNodeId === "string") {
    deepStripped.entryNodeId = nodeKeyMap.get(deepStripped.entryNodeId) ?? deepStripped.entryNodeId;
  }

  // Capture staticNodes key set; discard coords.
  const staticNodeKeys = new Set<string>();
  if (deepStripped.staticNodes && typeof deepStripped.staticNodes === "object") {
    for (const k of Object.keys(deepStripped.staticNodes as Record<string, unknown>)) {
      staticNodeKeys.add(nodeKeyMap.get(k) ?? k);
    }
    delete deepStripped.staticNodes;
  }

  // Rewrite nodes map keys + connections, strip x/y.
  if (deepStripped.nodes && typeof deepStripped.nodes === "object") {
    const rewritten: Record<string, Record<string, unknown>> = {};
    for (const [uuid, entry] of Object.entries(deepStripped.nodes as Record<string, Record<string, unknown>>)) {
      const stableKey = nodeKeyMap.get(uuid) ?? `${entry.nodeType}:${entry.displayName}`;
      const copy: Record<string, unknown> = { ...entry };
      delete copy.x;
      delete copy.y;
      if (copy.connections && typeof copy.connections === "object") {
        const cxs: Record<string, string> = {};
        for (const [outcome, target] of Object.entries(copy.connections as Record<string, string>)) {
          cxs[outcome] = nodeKeyMap.get(target) ?? target;
        }
        copy.connections = cxs;
      }
      rewritten[stableKey] = copy;
    }
    deepStripped.nodes = rewritten;
  }

  // Normalize ESV escape artifacts in every string leaf before sorting so
  // the same placeholder compares equal across vendored / upstream exporters.
  const header = sortKeys(normalizeJsonEsvEscapes(deepStripped)) as Record<string, unknown>;

  return { name, header, nodes, staticNodeKeys, referencedScripts, referencedSubJourneys };
}
