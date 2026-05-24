// src/core/aic/federation.ts
import type { TokenCache } from "./auth";
import { createAuthedClient } from "./client";
import {
  samlProvidersListUrl, samlProviderDetailUrl,
  oidcClientsListUrl, oidcClientDetailUrl
} from "./urls";

interface ListResponse {
  result: Array<{ _id: string }>;
  resultCount: number;
}

async function listIds(url: string, cache: TokenCache): Promise<string[]> {
  const client = createAuthedClient(cache);
  const res = await client.get<ListResponse>(url);
  return res.data.result.map((r) => r._id);
}

async function fetchBody(url: string, cache: TokenCache): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.get<Record<string, unknown>>(url);
  return res.data;
}

async function putBody(url: string, body: Record<string, unknown>, cache: TokenCache): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.put<Record<string, unknown>>(url, body);
  return res.data;
}

export function listSamlProviders(tenantUrl: string, realm: string, cache: TokenCache): Promise<string[]> {
  return listIds(samlProvidersListUrl(tenantUrl, realm), cache);
}
export function fetchSamlProvider(tenantUrl: string, realm: string, id: string, cache: TokenCache): Promise<Record<string, unknown>> {
  return fetchBody(samlProviderDetailUrl(tenantUrl, realm, id), cache);
}
export function putSamlProvider(tenantUrl: string, realm: string, id: string, body: Record<string, unknown>, cache: TokenCache): Promise<Record<string, unknown>> {
  return putBody(samlProviderDetailUrl(tenantUrl, realm, id), body, cache);
}
export function listOidcClients(tenantUrl: string, realm: string, cache: TokenCache): Promise<string[]> {
  return listIds(oidcClientsListUrl(tenantUrl, realm), cache);
}
export function fetchOidcClient(tenantUrl: string, realm: string, id: string, cache: TokenCache): Promise<Record<string, unknown>> {
  return fetchBody(oidcClientDetailUrl(tenantUrl, realm, id), cache);
}
export function putOidcClient(tenantUrl: string, realm: string, id: string, body: Record<string, unknown>, cache: TokenCache): Promise<Record<string, unknown>> {
  return putBody(oidcClientDetailUrl(tenantUrl, realm, id), body, cache);
}
