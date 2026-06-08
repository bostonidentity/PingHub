import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { getJourneyReportRegistry } from "@/lib/reports/journey-report-registry";
import { journeyReportRoot, reportPath } from "@/lib/reports/journey-report-paths";
import { inspectStoredRaw } from "@/lib/reports/journey-raw";

export const dynamic = "force-dynamic";

/**
 * Re-analyze a completed run's RETAINED raw (opt-in `retainRaw`) — offline, no AIC
 * call — optionally scoped to one journey, returning a full per-attempt detail
 * report. 404 when nothing was retained (or it has aged out of the retention cap),
 * so the client can fall back to a fresh re-pull.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getJourneyReportRegistry().getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const treeName = typeof body?.treeName === "string" && body.treeName ? body.treeName : undefined;

  const reportRoot = journeyReportRoot(job.env);
  const result = inspectStoredRaw(reportRoot, id, { treeName });
  if (!result) {
    return NextResponse.json({ error: "no retained raw for this report" }, { status: 404 });
  }

  // Carry the original window from the saved report so the detail view keeps context.
  let window: { from: string; to: string } | undefined;
  try {
    const saved = JSON.parse(fs.readFileSync(reportPath(reportRoot, id), "utf-8"));
    if (saved?.window?.from && saved?.window?.to) window = { from: saved.window.from, to: saved.window.to };
  } catch { /* report file may be gone; window is optional */ }

  return NextResponse.json({
    summary: result.summary,
    attempts: result.attempts,
    perJourney: result.perJourney,
    rollupOnly: false,
    source: "live" as const,
    env: job.env,
    ...(window ? { window } : {}),
    ...(treeName ? { selectedJourneys: [treeName] } : {}),
    rawJobId: id, // keep the inspected view re-inspectable (e.g. a different journey)
    inspectedFromRaw: true,
    attemptsTruncated: result.attemptsTruncated,
  });
}
