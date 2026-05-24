import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { journeyFile, federationFile } from "./paths";

export function writeJourney(
  snapshotDir: string,
  realm: string,
  id: string,
  body: unknown
): void {
  const p = journeyFile(snapshotDir, realm, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
}

export function writeFederation(
  snapshotDir: string,
  realm: string,
  type: string,
  id: string,
  body: unknown
): void {
  const p = federationFile(snapshotDir, realm, type, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
}
