import { NextRequest, NextResponse } from "next/server";
import { getLogRegistry } from "@/lib/logs/log-job-registry";
import { getController } from "../../../route-controllers";

export const dynamic = "force-dynamic";

/**
 * Suspend a running pull. Flip status to "suspending" BEFORE aborting so the
 * runner's abort path finalizes to the resumable "suspended" state (per-source
 * cookies are already persisted). Lifecycle: running → suspending → suspended.
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const registry = getLogRegistry();
    const job = registry.getJob(id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (job.status === "suspended" || job.status === "suspending") {
        return NextResponse.json({ jobId: id, status: job.status }, { status: 200 });
    }
    if (job.status !== "running" && job.status !== "queued") {
        return NextResponse.json({ error: `cannot suspend job in status '${job.status}'` }, { status: 409 });
    }

    registry.setJobStatus(id, "suspending");
    getController(id)?.abort();
    return NextResponse.json({ jobId: id, status: "suspending" }, { status: 202 });
}
