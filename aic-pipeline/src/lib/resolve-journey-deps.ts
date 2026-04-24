import fs from "fs";
import path from "path";
import { getRealmRoots } from "./realm-paths";

export interface JourneyDeps {
  /** Inner journey names discovered recursively */
  subJourneys: string[];
  /** Script UUIDs referenced by journey nodes */
  scriptUuids: string[];
  /** Map of script UUID → human-readable name */
  scriptNames: Map<string, string>;
  /** Journey names referenced by selected journeys but not found on disk */
  missingSubJourneys: string[];
  /** Script UUIDs referenced by selected journeys but not found in scripts-config */
  missingScriptUuids: string[];
}

/**
 * Scan journey node files to discover referenced scripts and inner journeys.
 * Mirrors the dependency resolution logic used by fr-config-push --push-dependencies.
 */
export function resolveJourneyDeps(
  configDir: string,
  journeyNames: string[],
): JourneyDeps {
  const scriptNames = new Map<string, string>(); // uuid → name

  // Build script UUID → name map from scripts-config across both layouts
  // (configDir/realms/<r>/... and configDir/<r>/...).
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const cfgDir = path.join(realmRoot, "scripts", "scripts-config");
    for (const f of fs.readdirSync(cfgDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const json = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf-8"));
        if (json._id && json.name) scriptNames.set(json._id, json.name);
      } catch { /* skip */ }
    }
  }

  const allSubJourneys = new Set<string>();
  const allScriptUuids = new Set<string>();
  const missingSubJourneys = new Set<string>();

  const scanDeps = (journeyName: string, visited: Set<string>) => {
    if (visited.has(journeyName)) return;
    visited.add(journeyName);

    const realmRoots = getRealmRoots(configDir, path.join("journeys", journeyName, "nodes"));
    if (realmRoots.length === 0) {
      missingSubJourneys.add(journeyName);
      return;
    }

    for (const realmRoot of realmRoots) {
      const nodesDir = path.join(realmRoot, "journeys", journeyName, "nodes");
      for (const nf of fs.readdirSync(nodesDir)) {
        const fp = path.join(nodesDir, nf);
        if (fs.statSync(fp).isDirectory()) continue;
        try {
          const nd = JSON.parse(fs.readFileSync(fp, "utf-8")) as {
            script?: string;
            tree?: string;
            _type?: { _id?: string };
          };
          if (nd.script) allScriptUuids.add(nd.script);
          if (nd._type?._id === "InnerTreeEvaluatorNode" && nd.tree) {
            allSubJourneys.add(nd.tree);
            scanDeps(nd.tree, visited);
          }
        } catch { /* skip */ }
      }
    }
  };

  for (const name of journeyNames) {
    scanDeps(name, new Set());
  }

  return {
    subJourneys: [...allSubJourneys],
    scriptUuids: [...allScriptUuids],
    scriptNames,
    missingSubJourneys: [...missingSubJourneys],
    missingScriptUuids: [...allScriptUuids].filter((uuid) => !scriptNames.has(uuid)),
  };
}
