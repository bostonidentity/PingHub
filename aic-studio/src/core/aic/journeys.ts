// src/core/aic/journeys.ts
import type { TokenCache } from "./auth";
import { createAuthedClient } from "./client";
import { journeysListUrl, journeyDetailUrl } from "./urls";

interface JourneyListResponse {
  result: Array<{ _id: string; _rev?: string }>;
  resultCount: number;
}

export async function listJourneys(
  tenantUrl: string,
  realm: string,
  cache: TokenCache
): Promise<string[]> {
  const client = createAuthedClient(cache);
  const res = await client.get<JourneyListResponse>(journeysListUrl(tenantUrl, realm));
  return res.data.result.map((r) => r._id);
}

export async function fetchJourney(
  tenantUrl: string,
  realm: string,
  id: string,
  cache: TokenCache
): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.get<Record<string, unknown>>(journeyDetailUrl(tenantUrl, realm, id));
  return res.data;
}

export async function putJourney(
  tenantUrl: string,
  realm: string,
  id: string,
  body: Record<string, unknown>,
  cache: TokenCache
): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.put<Record<string, unknown>>(journeyDetailUrl(tenantUrl, realm, id), body);
  return res.data;
}
