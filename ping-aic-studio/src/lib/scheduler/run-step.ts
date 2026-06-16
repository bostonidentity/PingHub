import { runSync } from "@/lib/operations/run-sync";
import { runGitPush } from "@/lib/operations/run-git-push";
import { runDataPull } from "@/lib/operations/run-data-pull";
import { readEnvVars } from "@/lib/scheduler/env-vars";
import type { Step } from "@/lib/scheduler/types";
import type { OpEventSink, OpResult } from "@/lib/operations/types";

export async function runStep(step: Step, scheduleId: string, emit: OpEventSink): Promise<OpResult> {
  switch (step.type) {
    case "sync":
      return runSync({ environment: step.environment, scopes: step.scopes, trigger: "scheduled", scheduleId }, emit);
    case "pull-data":
      return runDataPull({ environment: step.environment, managedObjects: step.managedObjects, envVars: readEnvVars(step.environment), trigger: "scheduled", scheduleId }, emit);
    case "git-push":
      return runGitPush({ message: step.message, force: step.force, trigger: "scheduled", scheduleId }, emit);
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown step type: ${(_exhaustive as { type?: string }).type}`);
    }
  }
}
