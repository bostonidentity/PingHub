export type {
  CanonicalScript, CanonicalNode, CanonicalJourney,
  EqualityReason, EqualityResult, NodeRefRegistry,
} from "./types";
export { canonicalizeScript, scriptIdentity, normalizeScriptBody } from "./script-canon";
export { scriptsEqual } from "./script-equal";
export { buildScriptMap } from "./script-map";
export { buildNodeKeyMap } from "./node-key-map";
export { canonicalizeNode } from "./node-canon";
export { canonicalizeJourney } from "./journey-canon";
export { journeysEqual } from "./journey-equal";
export { NODE_REFS, getRefsFor } from "./node-refs";
export { sortKeys, stripFields, normalizeEsvEscapes, normalizeJsonEsvEscapes, isEmptyJsonValue } from "./json-canon";
