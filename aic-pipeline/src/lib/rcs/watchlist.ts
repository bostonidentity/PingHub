import fs from "node:fs";
import path from "node:path";

export type Watchlist = Record<string, string[]>;

export interface WatchlistOpts {
  rootDir?: string;
}

const FILE = "rcs-watchlist.json";

function filePath(envName: string, opts?: WatchlistOpts): string {
  const root = opts?.rootDir ?? process.cwd();
  return path.join(root, "environments", envName, FILE);
}

export function readWatchlist(envName: string, opts?: WatchlistOpts): Watchlist {
  const fp = filePath(envName, opts);
  if (!fs.existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Watchlist = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        out[k] = v as string[];
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeWatchlistEntry(
  envName: string,
  clusterName: string,
  include: string[] | null,
  opts?: WatchlistOpts,
): void {
  const current = readWatchlist(envName, opts);
  if (include === null) {
    delete current[clusterName];
  } else {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const name of include) {
      if (!seen.has(name)) {
        seen.add(name);
        deduped.push(name);
      }
    }
    current[clusterName] = deduped;
  }
  const fp = filePath(envName, opts);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(current, null, 2) + "\n");
}

export function filterConnectorsForProbe(
  allConnectors: string[],
  clusterName: string,
  watchlist: Watchlist,
): string[] {
  const entry = watchlist[clusterName];
  if (entry === undefined) return allConnectors;
  const allowed = new Set(entry);
  return allConnectors.filter((c) => allowed.has(c));
}
