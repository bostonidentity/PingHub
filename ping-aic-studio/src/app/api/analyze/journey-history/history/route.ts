import { NextRequest, NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { listHistoryReports, saveHistoryReport } from "@/lib/reports/journey-report-history";

export const dynamic = "force-dynamic";

function envOk(env: string): boolean {
  return !!env && getEnvironments().some((e) => e.name === env);
}

/** GET /api/analyze/journey-history/history?env=prod → { entries: JourneyHistoryMeta[] } */
export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") ?? "";
  if (!envOk(env)) return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  return NextResponse.json({ entries: listHistoryReports(env) });
}

/** POST { env, report } → persist a generated report to history → { meta } */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const env = typeof body.env === "string" ? body.env : "";
  if (!envOk(env)) return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  if (!body.report || typeof body.report !== "object") {
    return NextResponse.json({ error: "report required" }, { status: 400 });
  }
  const meta = saveHistoryReport(env, body.report);
  return NextResponse.json({ meta }, { status: 201 });
}
