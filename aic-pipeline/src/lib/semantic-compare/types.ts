export interface CanonicalScript {
  identity: string;           // "${context}/${name}"
  context: string;
  name: string;
  language: "JAVASCRIPT" | "GROOVY" | string;
  evaluatorVersion: string;
  defaultFlag: boolean;
  body: string;               // normalized body
  description: string | null; // flagged-only, not part of equality
}

export interface CanonicalNode {
  stableKey: string;          // "${nodeType}:${displayName}" + optional "#N"
  nodeType: string;
  displayName: string;
  payload: Record<string, unknown>; // node file JSON, UUIDs rewritten, metadata stripped
}

export interface CanonicalJourney {
  name: string;               // directory name
  header: Record<string, unknown>;   // canonicalized header fields
  nodes: Map<string, CanonicalNode>; // keyed by stableKey
  staticNodeKeys: Set<string>;
  referencedScripts: Set<string>;    // "${context}/${name}" tuples
  referencedSubJourneys: Set<string>;
}

export type EqualityReason =
  | { kind: "header"; fields: string[] }
  | { kind: "node-set"; added: string[]; removed: string[] }
  | { kind: "node-settings"; stableKey: string; diff?: unknown }
  | { kind: "script-missing"; identity: string; side: "source" | "target" }
  | { kind: "script-body"; identity: string }
  | { kind: "script-meta"; identity: string; fields: string[] }
  | { kind: "subjourney-missing"; name: string; side: "source" | "target" }
  | { kind: "subjourney-diff"; name: string; reasons: EqualityReason[] };

export interface EqualityResult {
  equal: boolean;
  reasons: EqualityReason[];
}

export interface NodeRefRegistry {
  [nodeType: string]: {
    scriptRefs?: string[];       // fields holding a script UUID
    treeRefs?: string[];         // fields holding an inner-journey name
    nodeRefs?: string[];         // fields holding node UUIDs (e.g. PageNode.nodes[]._id)
  };
}
