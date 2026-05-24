import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { latestSnapshotDir, journeyFile } from "./paths";

export function readJourneyFromLatest(
  globalStoragePath: string,
  envName: string,
  realm: string,
  id: string
): Record<string, unknown> | undefined {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return undefined;
  const file = journeyFile(dir, realm, id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function listRealmsInLatest(globalStoragePath: string, envName: string): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function listJourneysInLatest(
  globalStoragePath: string,
  envName: string,
  realm: string
): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return [];
  const realmDir = join(dir, realm, "journeys");
  if (!existsSync(realmDir)) return [];
  return readdirSync(realmDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.replace(/\.json$/, ""));
}

export function readJourneyFromSnapshot(
  snapshotDir: string,
  realm: string,
  id: string
): Record<string, unknown> | undefined {
  const file = journeyFile(snapshotDir, realm, id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
