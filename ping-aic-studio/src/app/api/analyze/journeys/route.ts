import { NextRequest, NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { listConfigJourneys } from "@/lib/journey-list";

export const dynamic = "force-dynamic";

/** GET /api/analyze/journeys?env=prod → { journeys: string[], source: "config" | "none" } */
export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") ?? "";
  if (!env || !getEnvironments().some((e) => e.name === env)) {
    return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  }
  return NextResponse.json(listConfigJourneys(env));
}
