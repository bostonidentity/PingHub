// src/core/analyze/indexer.ts
import { listRealmsInLatest, listJourneysInLatest, readJourneyFromLatest } from "../snapshots/reader";
import { extractRefs } from "./journeyRefs";
import type { Reference } from "./types";

export function indexEnv(globalStoragePath: string, envName: string): Reference[] {
  const refs: Reference[] = [];
  const realms = listRealmsInLatest(globalStoragePath, envName);
  for (const realm of realms) {
    const journeyIds = listJourneysInLatest(globalStoragePath, envName, realm);
    for (const id of journeyIds) {
      const body = readJourneyFromLatest(globalStoragePath, envName, realm, id);
      if (!body) continue;
      refs.push(...extractRefs({ realm, journeyId: id, body }));
    }
  }
  return refs;
}
