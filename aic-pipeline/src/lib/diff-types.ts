import type { EqualityReason } from "./semantic-compare/types";
export type { EqualityReason } from "./semantic-compare/types";

export interface SemanticJourneyReport {
  name: string;
  status: "equal" | "modified" | "added" | "removed";
  /** Present only when both sides exist (status === "modified" or "equal"). */
  reasons?: EqualityReason[];
}

export interface DiffLine {
  type: "context" | "added" | "removed";
  content: string;
}

export interface FileDiff {
  relativePath: string;
  /** Top-level config scope this file belongs to (e.g. "journeys", "scripts"). */
  scope?: string;
  status: "added" | "removed" | "modified" | "unchanged";
  diffLines?: DiffLine[];
  /** Source file content (modified / removed files). Absent if file too large. */
  localContent?: string;
  /** Target file content (modified / added files). Absent if file too large. */
  remoteContent?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface CompareEndpoint {
  environment: string;
  mode: "local" | "remote";
}

export interface DiffOptions {
  includeMetadata?: boolean;
  ignoreWhitespace?: boolean;
}

export interface JourneyScript {
  uuid: string;
  name: string;
  status: "modified" | "added" | "removed" | "unchanged";
}

export interface JourneyNodeInfo {
  uuid: string;
  /** Generic node-type label (e.g. "Scripted Decision") — the non-distinctive fallback. */
  name: string;
  /** Human-authored label from the journey's main JSON (e.g. "Device_Context"). */
  displayName?: string;
  nodeType: string;
  status: "modified" | "added" | "removed" | "unchanged";
  /** Why this node is "modified" — distinguishes script vs sub-journey changes */
  modifiedReason?: "script" | "subjourney";
}

export interface JourneyTreeNode {
  name: string;
  status: "modified" | "added" | "removed" | "unchanged";
  isEntry: boolean;
  subJourneys: JourneyTreeNode[];
  scripts: JourneyScript[];
  nodes: JourneyNodeInfo[];
}

export interface MissingDepsWarning {
  missingJourneys: string[];
  missingScripts: string[];
}

export interface CompareReport {
  source: CompareEndpoint;
  target: CompareEndpoint;
  generatedAt: string;
  options?: DiffOptions;
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
  files: FileDiff[];
  journeyTree?: JourneyTreeNode[];
  missingDeps?: MissingDepsWarning;
  /** Per-journey semantic equality report (undefined when journeys aren't in scope). */
  semanticJourneys?: SemanticJourneyReport[];
}
