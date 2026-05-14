import { NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { triggerStaleHealthRefreshAsync } from "@/lib/health/auto-refresh";
import { readHealthInfo } from "@/lib/health/persistence";
import type { HealthCacheEntry } from "@/lib/health/types";

export async function GET() {
  triggerStaleHealthRefreshAsync();
  const envs = getEnvironments();
  const payload = envs.map((e) => ({
    env: e.name,
    intervalMinutes: e.healthIntervalMinutes,
    info: readHealthInfo(e.name) as HealthCacheEntry | null,
  }));
  return NextResponse.json({ envs: payload });
}
