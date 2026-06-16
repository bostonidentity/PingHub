import { getRegistry } from "@/lib/data/job-registry";
import { runPull } from "@/lib/data/pull-runner";
import { getAccessToken } from "@/lib/iga-api";
import { getEnvironments } from "@/lib/fr-config";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { appendOpLog } from "@/lib/op-history";
import type { OpEventSink, OpResult } from "@/lib/operations/types";

export interface RunDataPullOpts {
  environment: string;
  managedObjects: string[];
  envVars: Record<string, string>;
  trigger?: "manual" | "scheduled";
  scheduleId?: string;
}

export async function runDataPull(opts: RunDataPullOpts, emit: OpEventSink): Promise<OpResult> {
  const { environment, managedObjects, envVars } = opts;
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  const envMeta = getEnvironments().find((e) => e.name === environment);
  const pageSize = typeof envMeta?.pageSize === "number" && envMeta.pageSize > 0 ? envMeta.pageSize : undefined;

  const registry = getRegistry();
  const job = registry.startJob(environment, managedObjects);
  emit({ type: "data", action: "job-start", jobId: job.id, ts: Date.now() });

  const controller = new AbortController();
  let error: string | undefined;
  try {
    await runPull({
      job,
      registry,
      envsRoot: ENVIRONMENTS_DIR,
      envVars,
      mintToken: (vars) => getAccessToken(vars),
      signal: controller.signal,
      pageSize,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const finalJob = registry.getJob(job.id);
  const ok = !error && finalJob?.status === "completed";
  const summary = ok
    ? `Data pull complete for ${managedObjects.length} type${managedObjects.length !== 1 ? "s" : ""}`
    : `Data pull ${finalJob?.status ?? "failed"}${error ? `: ${error}` : ""}`;

  let runId: string | undefined;
  try {
    runId = appendOpLog({
      type: "pull",
      environment,
      scopes: managedObjects,
      status: ok ? "success" : "failed",
      startedAt,
      durationMs: Date.now() - startTime,
      summary,
      trigger: opts.trigger,
      scheduleId: opts.scheduleId,
    }).id;
  } catch { /* non-fatal */ }

  emit({ type: "data", action: "job-end", jobId: job.id, status: finalJob?.status, ts: Date.now() });
  return { status: ok ? "success" : "failed", summary, durationMs: Date.now() - startTime, runId, error };
}
