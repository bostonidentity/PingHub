import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./fr-config";
import { getRealmRoots } from "./realm-paths";

export interface JourneyListResult {
  journeys: string[];
  source: "config" | "none";
}

/**
 * Scan a resolved config dir for journey names:
 * `<configDir>/<realm>/journeys/<journeyName>/`. Sorted + de-duped across realms.
 * `null`/missing/empty → `{ journeys: [], source: "none" }` (drives the UI's
 * free-text fallback).
 */
export function scanJourneyNames(configDir: string | null): JourneyListResult {
  if (!configDir || !fs.existsSync(configDir)) return { journeys: [], source: "none" };
  const names = new Set<string>();
  for (const realmRoot of getRealmRoots(configDir, "journeys")) {
    const journeysDir = path.join(realmRoot, "journeys");
    for (const e of fs.readdirSync(journeysDir, { withFileTypes: true })) {
      if (e.isDirectory()) names.add(e.name);
    }
  }
  if (names.size === 0) return { journeys: [], source: "none" };
  return { journeys: [...names].sort((a, b) => a.localeCompare(b)), source: "config" };
}

/** List journey names for an environment from its pulled config. */
export function listConfigJourneys(env: string): JourneyListResult {
  return scanJourneyNames(getConfigDir(env));
}
