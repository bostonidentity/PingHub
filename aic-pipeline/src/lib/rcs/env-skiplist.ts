import fs from "node:fs";
import path from "node:path";

export interface SkiplistOpts {
  rootDir?: string;
}

const FILE = "rcs-env-skiplist.json";

function filePath(opts?: SkiplistOpts): string {
  const root = opts?.rootDir ?? process.cwd();
  return path.join(root, "environments", FILE);
}

export function readSkiplist(opts?: SkiplistOpts): string[] {
  const fp = filePath(opts);
  if (!fs.existsSync(fp)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const skip = (parsed as { skip?: unknown }).skip;
    if (!Array.isArray(skip)) return [];
    return skip.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function setEnvSkipped(envName: string, skip: boolean, opts?: SkiplistOpts): void {
  const current = new Set(readSkiplist(opts));
  if (skip) current.add(envName);
  else current.delete(envName);
  const fp = filePath(opts);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ skip: Array.from(current) }, null, 2) + "\n");
}
