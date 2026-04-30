// src/app/api/data/pull/jobs/[jobId]/resume/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { parseEnvFile } from "@/lib/env-parser";
import { getAccessToken } from "@/lib/iga-api";
import { getRegistry } from "@/lib/data/job-registry";
import { runPull } from "@/lib/data/pull-runner";
import { getEnvironments } from "@/lib/fr-config";
import { setController, deleteController } from "../../../route-controllers";

export const dynamic = "force-dynamic";

function envVarsFor(env: string): Record<string, string> | null {
  const envFile = path.join(ENVIRONMENTS_DIR, env, ".env");
  if (!fs.existsSync(envFile)) return null;
  return parseEnvFile(fs.readFileSync(envFile, "utf-8")) as Record<string, string>;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const registry = getRegistry();
  const job = registry.getJob(jobId);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "interrupted") {
    return NextResponse.json(
      { error: `cannot resume job in status '${job.status}'` },
      { status: 409 },
    );
  }

  // Another active job for the same env blocks resume.
  const active = registry.getActiveJobForEnv(job.env);
  if (active && active.id !== job.id) {
    return NextResponse.json(
      { jobId: active.id, status: active.status, error: "another job is active for this env" },
      { status: 409 },
    );
  }

  const envVars = envVarsFor(job.env);
  if (!envVars) return NextResponse.json({ error: "env not found" }, { status: 404 });

  const envMeta = getEnvironments().find((e) => e.name === job.env);
  const envPageSize = typeof envMeta?.pageSize === "number" && envMeta.pageSize > 0
    ? envMeta.pageSize
    : undefined;
  const globalPageSize = process.env.DATA_PULL_PAGE_SIZE
    ? parseInt(process.env.DATA_PULL_PAGE_SIZE, 10) || undefined
    : undefined;
  const pageSize = envPageSize ?? globalPageSize;

  const ctl = new AbortController();
  setController(job.id, ctl);

  void runPull({
    job,
    registry,
    envsRoot: ENVIRONMENTS_DIR,
    envVars,
    mintToken: (vars) => getAccessToken(vars),
    signal: ctl.signal,
    pageSize,
  }).finally(() => deleteController(job.id));

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
