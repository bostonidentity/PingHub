import type { CanonicalNode } from "./types";
import { sortKeys, stripFields, normalizeJsonEsvEscapes } from "./json-canon";
import { getRefsFor } from "./node-refs";

// Fields stripped only from the top-level node object.
const STRIP_TOP = ["_id", "_rev"];
// Fields stripped deeply (metadata that should never appear anywhere).
const STRIP_DEEP = ["createdBy", "creationDate", "lastModifiedBy", "lastModifiedDate", "lastChangeDate", "lastChangedBy"];

export function canonicalizeNode(
  raw: Record<string, unknown>,
  nodeType: string,
  nodeKeyMap: Map<string, string>,
  scriptMap: Map<string, string>,
): CanonicalNode {
  const stableKey = pickStableKey(raw, nodeType, nodeKeyMap);
  const displayName = String(raw.displayName ?? "");

  // Strip top-level identity fields first (non-recursive so nested _id is preserved).
  const topStripped: Record<string, unknown> = { ...raw };
  for (const f of STRIP_TOP) delete topStripped[f];

  // Then deep-strip metadata fields.
  let payload = stripFields(topStripped, STRIP_DEEP) as Record<string, unknown>;

  const refs = getRefsFor(nodeType);

  // Rewrite script UUID fields.
  for (const field of refs.scriptRefs ?? []) {
    const v = payload[field];
    if (typeof v === "string") {
      payload[field] = scriptMap.has(v) ? scriptMap.get(v)! : `<missing:${v}>`;
    }
  }

  // Rewrite nested node refs (e.g. PageNode.nodes[]._id).
  for (const field of refs.nodeRefs ?? []) {
    const arr = payload[field];
    if (Array.isArray(arr)) {
      payload[field] = arr.map((child) => {
        if (child && typeof child === "object") {
          const c = child as Record<string, unknown>;
          const id = typeof c._id === "string" ? c._id : null;
          const rewritten: Record<string, unknown> = { ...c };
          if (id) rewritten._id = nodeKeyMap.get(id) ?? `<missing:${id}>`;
          return rewritten;
        }
        return child;
      });
    }
  }

  // Normalize ESV escape artifacts in every string leaf so \${foo} and ${foo}
  // compare equal regardless of which exporter produced the file.
  payload = normalizeJsonEsvEscapes(payload) as Record<string, unknown>;
  payload = sortKeys(payload) as Record<string, unknown>;

  return { stableKey, nodeType, displayName, payload };
}

function pickStableKey(
  raw: Record<string, unknown>,
  nodeType: string,
  nodeKeyMap: Map<string, string>,
): string {
  const id = typeof raw._id === "string" ? raw._id : null;
  if (id && nodeKeyMap.has(id)) return nodeKeyMap.get(id)!;
  const displayName = String(raw.displayName ?? "");
  return `${nodeType}:${displayName}`;
}
