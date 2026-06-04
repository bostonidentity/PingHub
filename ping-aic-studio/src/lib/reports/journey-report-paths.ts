import path from "node:path";
import { ENVIRONMENTS_DIR } from "@/lib/paths";

/** A single, safe path segment: no separators, no traversal. */
function safeSeg(value: string, label: string): string {
  if (!value || value === "." || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value;
}

/** Root for an env's journey-report jobs: `ENVIRONMENTS_DIR/{env}/journey-reports`. */
export function journeyReportRoot(env: string): string {
  return path.join(ENVIRONMENTS_DIR, safeSeg(env, "env"), "journey-reports");
}

/** Where the runner streams matched events while a job runs. */
export function stagingPath(reportRoot: string, jobId: string): string {
  return path.join(reportRoot, ".staging", `${safeSeg(jobId, "jobId")}.ndjson`);
}

/** Where the finished, analyzed report is written. */
export function reportPath(reportRoot: string, jobId: string): string {
  return path.join(reportRoot, ".reports", `${safeSeg(jobId, "jobId")}.json`);
}
