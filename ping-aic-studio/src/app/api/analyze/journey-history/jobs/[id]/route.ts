import { NextRequest, NextResponse } from "next/server";
import { getJourneyReportRegistry } from "@/lib/reports/journey-report-registry";
import { getController } from "../../route-controllers";

export const dynamic = "force-dynamic";

/**
 * Abort (discard) a journey report. A running job is aborted via its controller
 * (the runner finalizes to "aborted"); a paused (interrupted/suspended) job —
 * which has no live runner — is set to "aborted" directly so the env's
 * active-job slot is freed for a fresh start.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const registry = getJourneyReportRegistry();
  const job = registry.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status === "completed" || job.status === "failed" || job.status === "aborted") {
    return new NextResponse(null, { status: 204 });
  }
  if (job.status === "interrupted" || job.status === "suspended") {
    registry.setJobStatus(id, "aborted");
    return new NextResponse(null, { status: 204 });
  }
  registry.setJobStatus(id, "aborting");
  getController(id)?.abort();
  return new NextResponse(null, { status: 204 });
}
