import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { latestSnapshotDir, journeyFile, federationFile } from "./paths";

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

export function readFederationFromLatest(
  globalStoragePath: string, envName: string, realm: string, type: string, id: string
): Record<string, unknown> | undefined {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return undefined;
  const file = federationFile(dir, realm, type, id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function listFederationTypesInLatest(globalStoragePath: string, envName: string, realm: string): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return [];
  const fedDir = join(dir, realm, "federation");
  if (!existsSync(fedDir)) return [];
  return readdirSync(fedDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

export function listFederationIdsInLatest(globalStoragePath: string, envName: string, realm: string, type: string): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return [];
  const d = join(dir, realm, "federation", type);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.replace(/\.json$/, ""));
}
