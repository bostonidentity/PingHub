import { NextRequest, NextResponse } from "next/server";
import { parseEnvFile } from "@/lib/env-parser";
import { getEnvFileContent } from "@/lib/fr-config";
import { getAccessToken } from "@/lib/iga-api";
import { fetchReleaseInfo } from "@/lib/release/fetch";
import { writeReleaseInfo } from "@/lib/release/persistence";
import type { ReleaseCacheEntry } from "@/lib/release/types";

const FETCH_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  const { env } = (await req.json()) as { env?: string };
  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });

  const entry = await refreshOne(env);
  if (entry.error) return NextResponse.json(entry, { status: 502 });
  return NextResponse.json(entry);
}

export async function refreshOne(env: string): Promise<ReleaseCacheEntry> {
  const fetchedAt = new Date().toISOString();
  try {
    const envContent = getEnvFileContent(env);
    const envVars = parseEnvFile(envContent);
    const tenantUrl = envVars.TENANT_BASE_URL;
    if (!tenantUrl) {
      const entry: ReleaseCacheEntry = { fetchedAt, error: "TENANT_BASE_URL missing from .env" };
      writeReleaseInfo(env, entry);
      return entry;
    }
    const token = await getAccessToken(envVars);
    const info = await fetchReleaseInfo({ tenantUrl, token, timeoutMs: FETCH_TIMEOUT_MS });
    const entry: ReleaseCacheEntry = { fetchedAt, info };
    writeReleaseInfo(env, entry);
    return entry;
  } catch (err) {
    const entry: ReleaseCacheEntry = {
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
    writeReleaseInfo(env, entry);
    return entry;
  }
}
