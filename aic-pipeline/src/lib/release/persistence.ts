import fs from "node:fs";
import path from "node:path";
import type { ReleaseCacheEntry } from "./types";

export interface PersistenceOpts {
  rootDir?: string;
}

const FILE = "release.json";

function filePath(envName: string, opts?: PersistenceOpts): string {
  const root = opts?.rootDir ?? process.cwd();
  return path.join(root, "environments", envName, FILE);
}

export function readReleaseInfo(envName: string, opts?: PersistenceOpts): ReleaseCacheEntry | null {
  const fp = filePath(envName, opts);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8")) as ReleaseCacheEntry;
  } catch {
    return null;
  }
}

export function writeReleaseInfo(envName: string, entry: ReleaseCacheEntry, opts?: PersistenceOpts): void {
  const fp = filePath(envName, opts);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(entry, null, 2) + "\n");
}
