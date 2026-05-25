import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { readHistoryMerged, appendOpLog, savePromotionReport, type OpType, type OpStatus } from "@/lib/op-history";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const environment = searchParams.get("environment") ?? undefined;
  const type = (searchParams.get("type") as OpType | null) ?? undefined;
  const limitStr = searchParams.get("limit");
  const limit = limitStr ? Math.min(Math.max(Number(limitStr), 1), 2000) : undefined;

  const records = readHistoryMerged({ environment, type, limit });
  return NextResponse.json(records);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body.type || !body.environment) {
    return NextResponse.json({ error: "Missing type or environment" }, { status: 400 });
  }
  // Pre-save the report file so we can include the reportId in the op-log entry
  let reportId: string | undefined;
  if (body.report) {
    try {
      const id = crypto.randomUUID();
      savePromotionReport(id, body.report);
      reportId = id;
    } catch { /* non-fatal */ }
  }

  const record = appendOpLog({
    type: body.type as OpType,
    environment: String(body.environment),
    scopes: Array.isArray(body.scopes) ? body.scopes : [],
    status: (body.status as OpStatus) ?? "success",
    startedAt: body.startedAt ?? new Date().toISOString(),
    durationMs: Number(body.durationMs ?? 0),
    summary: String(body.summary ?? ""),
    source: body.source,
    target: body.target,
    taskId: body.taskId,
    taskName: body.taskName,
    phaseOutcomes: body.phaseOutcomes,
    logSource: body.logSource,
    logMode: body.logMode,
    logPreset: body.logPreset,
    logEntryCount: body.logEntryCount,
    items: body.items,
    diffTotals: body.diffTotals,
    phaseTimings: body.phaseTimings,
    reportId,
  });

  return NextResponse.json({ id: record.id });
}
