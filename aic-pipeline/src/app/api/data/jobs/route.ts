import { NextRequest, NextResponse } from "next/server";
import { getRegistry } from "@/lib/data/job-registry";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const env = url.searchParams.get("env") ?? undefined;
  const includeFinished = url.searchParams.get("includeFinished") !== "false";
  const jobs = getRegistry().listJobs({ env, includeFinished });
  return NextResponse.json({ jobs });
}
