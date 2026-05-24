import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export function snapshotRoot(globalStoragePath: string): string {
  return join(globalStoragePath, "snapshots");
}

export function envSnapshotDir(globalStoragePath: string, envName: string): string {
  return join(snapshotRoot(globalStoragePath), envName);
}

export function isoStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, "-").replace(/\.\d+/, "");
}

export function journeyFile(snapshotDir: string, realm: string, id: string): string {
  return join(snapshotDir, realm, "journeys", `${id}.json`);
}

export function latestSnapshotDir(globalStoragePath: string, envName: string): string | undefined {
  const dir = envSnapshotDir(globalStoragePath, envName);
  if (!existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, mtimeMs: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.length > 0 ? join(dir, entries[0].name) : undefined;
}
