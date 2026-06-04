import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { journeyReportRoot } from "@/lib/reports/journey-report-paths";
import { getJourneyReportRegistry } from "@/lib/reports/journey-report-registry";
import { runJourneyReport } from "@/lib/reports/journey-report-runner";
import { setController, deleteController } from "../../../route-controllers";

export const dynamic = "force-dynamic";

/** Resume an interrupted/suspended report from its persisted cookie. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const registry = getJourneyReportRegistry();
  const job = registry.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "interrupted" && job.status !== "suspended") {
    return NextResponse.json({ error: `cannot resume job in status '${job.status}'` }, { status: 409 });
  }

  // Block resume if a DIFFERENT job is active for the env.
  const active = registry.getActiveJobForEnv(job.env);
  if (active && active.id !== job.id) {
    return NextResponse.json(
      { jobId: active.id, status: active.status, error: "another job is active for this env" },
      { status: 409 },
    );
  }

  const creds = getLogApiCredentials(job.env);
  if (!creds) {
    return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });
  }
  const vars = parseEnvFile(getEnvFileContent(job.env));
  const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
  if (!tenantBaseUrl) {
    return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });
  }

  const ctl = new AbortController();
  setController(job.id, ctl);
  void runJourneyReport({
    job,
    registry,
    reportRoot: journeyReportRoot(job.env),
    tenantBaseUrl,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    signal: ctl.signal,
  }).finally(() => deleteController(job.id));

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
