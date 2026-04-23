import fs from "node:fs";
import path from "node:path";
import type { RcsStatusFile } from "./types";

export interface PersistenceOpts {
  rootDir?: string;
}

const STATUS_FILENAME = "rcs-status.json";

function statusPath(envName: string, opts?: PersistenceOpts): string {
  const root = opts?.rootDir ?? process.cwd();
  return path.join(root, "environments", envName, STATUS_FILENAME);
}

export function readStatus(envName: string, opts?: PersistenceOpts): RcsStatusFile | null {
  const file = statusPath(envName, opts);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as RcsStatusFile;
}

export function writeStatus(envName: string, data: RcsStatusFile, opts?: PersistenceOpts): void {
  const file = statusPath(envName, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
