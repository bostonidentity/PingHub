import { indexEnv } from "./indexer";
import type { ResourceRef, UsageResult } from "./types";

export function findUsage(
  globalStoragePath: string,
  envName: string,
  target: ResourceRef
): UsageResult {
  const allRefs = indexEnv(globalStoragePath, envName);
  const refs = allRefs.filter(
    (r) =>
      r.target.realm === target.realm &&
      r.target.resourceType === target.resourceType &&
      r.target.id === target.id
  );
  return { target, refs };
}

export type { ResourceRef, Reference, UsageResult, ResourceType } from "./types";
