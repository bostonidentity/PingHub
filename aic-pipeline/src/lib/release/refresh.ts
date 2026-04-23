import { parseEnvFile } from "@/lib/env-parser";
import { getEnvFileContent } from "@/lib/fr-config";
import { getAccessToken } from "@/lib/iga-api";
import { fetchReleaseInfo } from "./fetch";
import { writeReleaseInfo } from "./persistence";
import type { ReleaseCacheEntry } from "./types";

const FETCH_TIMEOUT_MS = 10_000;

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
