import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent, getEnvironments } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { journeyReportRoot } from "@/lib/reports/journey-report-paths";
import { getJourneyReportRegistry, JourneyJobConflictError } from "@/lib/reports/journey-report-registry";
import { runJourneyReport } from "@/lib/reports/journey-report-runner";
import { setController, deleteController } from "../route-controllers";

export const dynamic = "force-dynamic";

const DEFAULT_MAX_EVENTS = 20000;
const HARD_MAX_EVENTS = 100000;

/** GET /api/analyze/journey-history/jobs?env=prod&includeFinished=1 */
export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") ?? undefined;
  const includeFinished = req.nextUrl.searchParams.get("includeFinished") === "1";
  const jobs = getJourneyReportRegistry().listJobs({ env, includeFinished });
  return NextResponse.json({ jobs });
}

/**
 * POST — start a background live journey-history report.
 * Body: { env, from, to, treeName?, maxEvents? }. Returns 202 with the jobId;
 * the client polls GET /jobs for progress and GET /jobs/{id}/report when done.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const env = typeof body.env === "string" ? body.env : "";
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const treeName = typeof body.treeName === "string" && body.treeName.trim() ? body.treeName.trim() : undefined;
  const maxEvents = Math.min(Math.max(1, Math.floor(Number(body.maxEvents) || DEFAULT_MAX_EVENTS)), HARD_MAX_EVENTS);
  const summaryOnly = body.summaryOnly === true;
  // AIC rejects queries spanning >1 day, so windows are sized in hours, capped at
  // 24. Explicit 0 = off (single window); omitted defaults to 24h so a long range
  // is chunked safely by default.
  const rawWindowHours = Number(body.windowHours);
  const windowHours = Number.isFinite(rawWindowHours)
    ? Math.min(Math.max(0, Math.floor(rawWindowHours)), 24)
    : 24;
  // Concurrent windows in a chunked run. AIC throttles bursts >~6, so clamp [1, 6].
  const rawConcurrency = Number(body.windowConcurrency);
  const windowConcurrency = Number.isFinite(rawConcurrency)
    ? Math.min(Math.max(1, Math.floor(rawConcurrency)), 6)
    : 4;

  if (!env || !from || !to) {
    return NextResponse.json({ error: "env, from, and to are required." }, { status: 400 });
  }
  if (!getEnvironments().some((e) => e.name === env)) {
    return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  }
  const creds = getLogApiCredentials(env);
  if (!creds) {
    return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });
  }
  const vars = parseEnvFile(getEnvFileContent(env));
  const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
  if (!tenantBaseUrl) {
    return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });
  }

  const registry = getJourneyReportRegistry();
  let job;
  try {
    job = registry.startJob(env, { from, to, treeName, maxEvents, summaryOnly, windowHours, windowConcurrency });
  } catch (e) {
    if (e instanceof JourneyJobConflictError || (e as Error).name === "JourneyJobConflictError") {
      const existingId = (e as JourneyJobConflictError).existingJobId;
      const existing = registry.getJob(existingId);
      return NextResponse.json({ jobId: existingId, status: existing?.status ?? "running" }, { status: 409 });
    }
    throw e;
  }

  const ctl = new AbortController();
  setController(job.id, ctl);
  void runJourneyReport({
    job,
    registry,
    reportRoot: journeyReportRoot(env),
    tenantBaseUrl,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    signal: ctl.signal,
  }).finally(() => deleteController(job.id));

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
