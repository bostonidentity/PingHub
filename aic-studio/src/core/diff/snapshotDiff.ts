import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envSnapshotDir } from "../snapshots/paths";

export interface ChangedItem {
  realm: string;
  resourceType: string;
  resourceId: string;
}

function listSnapshotDirsByMtime(globalStoragePath: string, envName: string): string[] {
  const root = envSnapshotDir(globalStoragePath, envName);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, m: statSync(join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((e) => join(root, e.name));
}

function collectJourneys(snapDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(snapDir)) return out;
  for (const realm of readdirSync(snapDir, { withFileTypes: true })) {
    if (!realm.isDirectory()) continue;
    const jdir = join(snapDir, realm.name, "journeys");
    if (!existsSync(jdir)) continue;
    for (const f of readdirSync(jdir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const id = f.name.replace(/\.json$/, "");
      out.set(`${realm.name}/${id}`, readFileSync(join(jdir, f.name), "utf8"));
    }
  }
  return out;
}

export function findLocallyModifiedJourneys(globalStoragePath: string, envName: string): ChangedItem[] {
  const dirs = listSnapshotDirsByMtime(globalStoragePath, envName);
  if (dirs.length < 2) return [];
  const latest = collectJourneys(dirs[0]);
  const prior = collectJourneys(dirs[1]);
  const changes: ChangedItem[] = [];
  for (const [key, body] of latest.entries()) {
    if (prior.get(key) !== body) {
      const [realm, id] = key.split("/");
      changes.push({ realm, resourceType: "journey", resourceId: id });
    }
  }
  return changes;
}
