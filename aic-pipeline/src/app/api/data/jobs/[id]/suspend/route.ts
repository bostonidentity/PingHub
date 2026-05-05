// src/app/api/data/jobs/[id]/suspend/route.ts
//
// Manually suspend a running pull. The runner observes the status flip
// (the registry returns the same DataPullJob object reference held by
// runPull), aborts at the next signal checkpoint, and skips the staging-
// dir cleanup so the resume endpoint can pick up from the persisted
// per-type _pagedResultsCookie + byteLength.
//
// Lifecycle: running → suspending (set here) → suspended (set by runner
// after it tears down). The suspended state survives server restart
// (job-registry preserves it instead of converting to "interrupted").

import { NextRequest, NextResponse } from "next/server";
import { getRegistry } from "@/lib/data/job-registry";
import { getController } from "../../../pull/route";

export const dynamic = "force-dynamic";

export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const registry = getRegistry();
    const job = registry.getJob(id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (job.status === "suspended" || job.status === "suspending") {
        return NextResponse.json({ jobId: id, status: job.status }, { status: 200 });
    }
    if (job.status !== "running" && job.status !== "queued") {
        return NextResponse.json(
            { error: `cannot suspend job in status '${job.status}'` },
            { status: 409 },
        );
    }

    // Order matters: flip status BEFORE aborting so the runner's
    // post-abort cleanup observes "suspending" and preserves the staging
    // dir + sets the final "suspended" status.
    registry.setJobStatus(id, "suspending");
    getController(id)?.abort();
    return NextResponse.json({ jobId: id, status: "suspending" }, { status: 202 });
}
