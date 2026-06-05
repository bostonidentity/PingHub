import { NextRequest, NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { getHistoryReport } from "@/lib/reports/journey-report-history";

export const dynamic = "force-dynamic";

/** GET /api/analyze/journey-history/history/<id>?env=prod → the full saved report */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = req.nextUrl.searchParams.get("env") ?? "";
  if (!env || !getEnvironments().some((e) => e.name === env)) {
    return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  }
  const { id } = await params;
  const report = getHistoryReport(env, id);
  if (!report) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(report);
}
