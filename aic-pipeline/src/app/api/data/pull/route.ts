// src/app/api/data/pull/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { cwd } from "process";
import fs from "fs";
import { parseEnvFile } from "@/lib/env-parser";
import { getAccessToken } from "@/lib/iga-api";
import { getRegistry, JobConflictError } from "@/lib/data/job-registry";
import { runPull } from "@/lib/data/pull-runner";

export const dynamic = "force-dynamic";

// One AbortController per in-flight job, keyed by job id. Scoped to this
// module so the DELETE route can look it up.
const controllers = new Map<string, AbortController>();
export function getController(id: string): AbortController | undefined {
  return controllers.get(id);
}

function envVarsFor(env: string): Record<string, string> | null {
  const envFile = path.join(cwd(), "environments", env, ".env");
  if (!fs.existsSync(envFile)) return null;
  return parseEnvFile(fs.readFileSync(envFile, "utf-8")) as Record<string, string>;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const env = typeof body.env === "string" ? body.env : "";
  const types = Array.isArray(body.types) ? body.types.filter((t: unknown) => typeof t === "string") : [];

  if (!env) return NextResponse.json({ error: "env is required" }, { status: 400 });
  if (types.length === 0) return NextResponse.json({ error: "types is required" }, { status: 400 });

  const envVars = envVarsFor(env);
  if (!envVars) return NextResponse.json({ error: "env not found" }, { status: 404 });

  const registry = getRegistry();
  let job;
  try {
    job = registry.startJob(env, types);
  } catch (e) {
    if (e instanceof JobConflictError) {
      const existing = registry.getJob(e.existingJobId);
      return NextResponse.json(
        { jobId: e.existingJobId, status: existing?.status ?? "running" },
        { status: 409 },
      );
    }
    throw e;
  }

  const ctl = new AbortController();
  controllers.set(job.id, ctl);

  void runPull({
    job,
    registry,
    envsRoot: path.join(cwd(), "environments"),
    envVars,
    mintToken: (vars) => getAccessToken(vars),
    signal: ctl.signal,
  }).finally(() => controllers.delete(job.id));

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
