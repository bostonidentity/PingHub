import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { journeyFile } from "./paths";

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
