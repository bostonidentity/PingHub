import type { NodeRefRegistry } from "./types";

export const NODE_REFS: NodeRefRegistry = {
  ScriptedDecisionNode:   { scriptRefs: ["script"] },
  ConfigProviderNode:     { scriptRefs: ["script"] },
  ConfigProviderNodeV2:   { scriptRefs: ["script"] },
  InnerTreeEvaluatorNode: { treeRefs: ["tree"] },
  PageNode:               { nodeRefs: ["nodes"] },
};

export function getRefsFor(nodeType: string): NodeRefRegistry[string] {
  const entry = NODE_REFS[nodeType];
  return entry ? { ...entry } : {};
}
