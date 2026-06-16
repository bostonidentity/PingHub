import { runSync } from "@/lib/operations/run-sync";
import { runGitPush } from "@/lib/operations/run-git-push";
import { runDataPull } from "@/lib/operations/run-data-pull";
import { readEnvVars } from "@/lib/scheduler/env-vars";
import type { Step } from "@/lib/scheduler/types";
import type { OpEventSink, OpResult } from "@/lib/operations/types";

function combine(results: OpResult[]): OpResult {
  if (results.length === 0) return { status: "success", summary: "No environments selected", durationMs: 0 };
  const failed = results.filter((r) => r.status === "failed");
  return {
    status: failed.length ? "failed" : "success",
    summary: results.map((r) => r.summary).join("; "),
    durationMs: results.reduce((a, r) => a + r.durationMs, 0),
    error: failed.length ? failed.map((r) => r.error).filter(Boolean).join("; ") || undefined : undefined,
  };
}

export async function runStep(step: Step, scheduleId: string, emit: OpEventSink): Promise<OpResult> {
  switch (step.type) {
    case "sync": {
      const results: OpResult[] = [];
      for (const env of step.environments) {
        results.push(await runSync({ environment: env, scopes: step.scopes, trigger: "scheduled", scheduleId }, emit));
      }
      return combine(results);
    }
    case "pull-data": {
      const results: OpResult[] = [];
      for (const env of step.environments) {
        results.push(await runDataPull({ environment: env, managedObjects: step.managedObjects, envVars: readEnvVars(env), trigger: "scheduled", scheduleId }, emit));
      }
      return combine(results);
    }
    case "git-push":
      return runGitPush({ message: step.message, force: step.force, trigger: "scheduled", scheduleId }, emit);
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown step type: ${(_exhaustive as { type?: string }).type}`);
    }
  }
}
