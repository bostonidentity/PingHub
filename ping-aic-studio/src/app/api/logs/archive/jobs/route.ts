import { NextRequest, NextResponse } from "next/server";
import { getLogRegistry } from "@/lib/logs/log-job-registry";

export const dynamic = "force-dynamic";

/** GET /api/logs/archive/jobs?env=prod&includeFinished=1 */
export async function GET(req: NextRequest) {
    const env = req.nextUrl.searchParams.get("env") ?? undefined;
    const includeFinished = req.nextUrl.searchParams.get("includeFinished") === "1";
    const jobs = getLogRegistry().listJobs({ env, includeFinished });
    return NextResponse.json({ jobs });
}
