import fs from "fs";
import path from "path";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { parseEnvFile } from "@/lib/env-parser";

/** Read and parse <env>/.env. Returns {} if missing. */
export function readEnvVars(environment: string): Record<string, string> {
  const f = path.join(ENVIRONMENTS_DIR, environment, ".env");
  if (!fs.existsSync(f)) return {};
  return parseEnvFile(fs.readFileSync(f, "utf-8")) as Record<string, string>;
}
