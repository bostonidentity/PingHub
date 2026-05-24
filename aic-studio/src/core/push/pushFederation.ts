// src/core/push/pushFederation.ts
import type { TokenCache } from "../aic/auth";
import { putSamlProvider, putOidcClient } from "../aic/federation";
import { readFederationFromLatest } from "../snapshots/reader";

export interface PushFederationParams {
  globalStoragePath: string;
  sourceEnvName: string;
  targetTenantUrl: string;
  targetTokenCache: TokenCache;
  realm: string;
  type: string;
  id: string;
}

export async function pushFederationFromSnapshot(params: PushFederationParams): Promise<{ ok: true }> {
  const body = readFederationFromLatest(
    params.globalStoragePath, params.sourceEnvName, params.realm, params.type, params.id
  );
  if (!body) throw new Error(`no snapshot found for ${params.sourceEnvName}/${params.realm}/federation/${params.type}/${params.id}`);
  if (params.type === "saml2") {
    await putSamlProvider(params.targetTenantUrl, params.realm, params.id, body, params.targetTokenCache);
  } else if (params.type === "OAuth2Client") {
    await putOidcClient(params.targetTenantUrl, params.realm, params.id, body, params.targetTokenCache);
  } else {
    throw new Error(`Unsupported federation type: ${params.type}`);
  }
  return { ok: true };
}
