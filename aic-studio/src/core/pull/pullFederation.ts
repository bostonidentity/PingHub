// src/core/pull/pullFederation.ts
import type { TokenCache } from "../aic/auth";
import {
  listSamlProviders, fetchSamlProvider,
  listOidcClients, fetchOidcClient
} from "../aic/federation";
import { writeFederation } from "../snapshots/writer";

export interface PullFederationParams {
  tenantUrl: string;
  tokenCache: TokenCache;
  envName: string;
  globalStoragePath: string;
  realms: string[];
  snapshotDir: string;
}

export interface PullFederationResult {
  snapshotDir: string;
  itemCount: number;
}

export async function pullAllFederation(params: PullFederationParams): Promise<PullFederationResult> {
  let count = 0;
  for (const realm of params.realms) {
    const samlIds = await listSamlProviders(params.tenantUrl, realm, params.tokenCache);
    for (const id of samlIds) {
      const body = await fetchSamlProvider(params.tenantUrl, realm, id, params.tokenCache);
      writeFederation(params.snapshotDir, realm, "saml2", id, body);
      count++;
    }
    const oidcIds = await listOidcClients(params.tenantUrl, realm, params.tokenCache);
    for (const id of oidcIds) {
      const body = await fetchOidcClient(params.tenantUrl, realm, id, params.tokenCache);
      writeFederation(params.snapshotDir, realm, "OAuth2Client", id, body);
      count++;
    }
  }
  return { snapshotDir: params.snapshotDir, itemCount: count };
}
