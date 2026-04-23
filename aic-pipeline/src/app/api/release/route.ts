import { NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { readReleaseInfo } from "@/lib/release/persistence";
import type { ReleaseCacheEntry } from "@/lib/release/types";

export async function GET() {
  const envs = getEnvironments();
  const payload = envs.map((e) => ({
    env: e.name,
    info: readReleaseInfo(e.name) as ReleaseCacheEntry | null,
  }));
  return NextResponse.json({ envs: payload });
}
