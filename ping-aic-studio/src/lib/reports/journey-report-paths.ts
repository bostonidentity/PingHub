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

/** Root holding every run's retained raw (opt-in, for offline inspection). */
export function rawRoot(reportRoot: string): string {
  return path.join(reportRoot, ".raw");
}

/** Directory holding one run's retained raw per-window NDJSON. */
export function rawDir(reportRoot: string, jobId: string): string {
  return path.join(rawRoot(reportRoot), safeSeg(jobId, "jobId"));
}

/** A single retained raw window file within `rawDir`. */
export function rawWindowPath(reportRoot: string, jobId: string, window: number): string {
  return path.join(rawDir(reportRoot, jobId), `w${Math.max(0, Math.floor(window))}.ndjson`);
}
