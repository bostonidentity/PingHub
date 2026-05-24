// src/core/pull/pullJourneys.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TokenCache } from "../aic/auth";
import { listRealms } from "../aic/realms";
import { listJourneys, fetchJourney } from "../aic/journeys";
import { envSnapshotDir, isoStamp } from "../snapshots/paths";
import { writeJourney } from "../snapshots/writer";

export interface PullParams {
  tenantUrl: string;
  tokenCache: TokenCache;
  envName: string;
  globalStoragePath: string;
}

export interface PullResult {
  snapshotDir: string;
  realmCount: number;
  journeyCount: number;
}

export async function pullAllJourneys(params: PullParams): Promise<PullResult> {
  const stamp = isoStamp();
  const snapshotDir = join(envSnapshotDir(params.globalStoragePath, params.envName), stamp);
  mkdirSync(snapshotDir, { recursive: true });

  const realms = await listRealms(params.tenantUrl, params.tokenCache);
  let journeyCount = 0;

  for (const realm of realms) {
    const ids = await listJourneys(params.tenantUrl, realm, params.tokenCache);
    for (const id of ids) {
      const body = await fetchJourney(params.tenantUrl, realm, id, params.tokenCache);
      writeJourney(snapshotDir, realm, id, body);
      journeyCount += 1;
    }
  }

  return { snapshotDir, realmCount: realms.length, journeyCount };
}
