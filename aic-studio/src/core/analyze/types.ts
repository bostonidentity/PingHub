// src/core/analyze/types.ts

export type ResourceType = "journey" | "script" | "saml2" | "OAuth2Client";

export interface ResourceRef {
  realm: string;
  resourceType: ResourceType;
  id: string;
}

export interface Reference {
  source: ResourceRef;
  target: ResourceRef;
  detail?: string;  // e.g. "node abc123" for journey node citation
}

export interface UsageResult {
  target: ResourceRef;
  refs: Reference[];
}
