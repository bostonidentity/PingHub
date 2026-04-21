import { NextRequest, NextResponse } from "next/server";
import { getRegistry } from "@/lib/data/job-registry";
import { getController } from "../../pull/route";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getRegistry().getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(job);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const registry = getRegistry();
  const job = registry.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status === "completed" || job.status === "failed" || job.status === "aborted") {
    return new NextResponse(null, { status: 204 });
  }
  registry.setJobStatus(id, "aborting");
  getController(id)?.abort();
  return new NextResponse(null, { status: 204 });
}
