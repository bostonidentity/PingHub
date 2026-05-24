// src/core/push/pushJourney.ts
import type { TokenCache } from "../aic/auth";
import { putJourney } from "../aic/journeys";
import { readJourneyFromLatest } from "../snapshots/reader";

export interface PushJourneyParams {
  globalStoragePath: string;
  sourceEnvName: string;
  targetTenantUrl: string;
  targetTokenCache: TokenCache;
  realm: string;
  journeyId: string;
}

export interface PushResult {
  ok: boolean;
  body: Record<string, unknown>;
}

export async function pushJourneyFromSnapshot(params: PushJourneyParams): Promise<PushResult> {
  const body = readJourneyFromLatest(
    params.globalStoragePath,
    params.sourceEnvName,
    params.realm,
    params.journeyId
  );
  if (!body) {
    throw new Error(`no snapshot found for ${params.sourceEnvName}/${params.realm}/${params.journeyId}`);
  }
  const result = await putJourney(
    params.targetTenantUrl,
    params.realm,
    params.journeyId,
    body,
    params.targetTokenCache
  );
  return { ok: true, body: result };
}
