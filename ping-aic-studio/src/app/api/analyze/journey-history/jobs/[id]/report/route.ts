import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { getJourneyReportRegistry } from "@/lib/reports/journey-report-registry";
import { journeyReportRoot, reportPath } from "@/lib/reports/journey-report-paths";

export const dynamic = "force-dynamic";

/** GET the finished report for a completed job. The report is kept out of the
 *  jobs list (it can be large) and fetched on demand once the job completes. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getJourneyReportRegistry().getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!job.reportReady) {
    return NextResponse.json({ error: `report not ready (status '${job.status}')` }, { status: 409 });
  }
  const file = reportPath(journeyReportRoot(job.env), id);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: "report file missing" }, { status: 404 });
  }
  // Already JSON on disk — stream it through without re-serializing.
  return new NextResponse(fs.readFileSync(file, "utf-8"), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
