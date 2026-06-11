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

export interface JourneyDepNode {
  /** Journey name. */
  name: string;
  children: JourneyDepNode[];
  /** Referenced by an InnerTreeEvaluatorNode but not found in config. */
  missing?: true;
  /** Already expanded elsewhere in this tree; children omitted (cycle guard). */
  repeated?: true;
}

/**
 * Resolve a journey's inner-journey closure from pulled config as a tree:
 * children are the trees referenced by the journey's InnerTreeEvaluatorNodes,
 * recursively. A journey reached a second time anywhere in the tree is marked
 * `repeated` and not re-expanded.
 */
export function resolveJourneyDepTree(configDir: string, journeyName: string): JourneyDepNode {
  const expanded = new Set<string>();
  const build = (name: string): JourneyDepNode => {
    // Journey names come from config dirs / node `tree` refs; anything with path
    // syntax is hostile or corrupt — treat as not-found rather than join it.
    if (/[/\\]|\.\.|\0/.test(name)) return { name, children: [], missing: true };
    if (expanded.has(name)) return { name, children: [], repeated: true };
    const realmRoots = getRealmRoots(configDir, path.join("journeys", name, "nodes"));
    if (realmRoots.length === 0) return { name, children: [], missing: true };
    expanded.add(name);
    const childNames = new Set<string>();
    for (const realmRoot of realmRoots) {
      const nodesDir = path.join(realmRoot, "journeys", name, "nodes");
      for (const nf of fs.readdirSync(nodesDir)) {
        const fp = path.join(nodesDir, nf);
        if (fs.statSync(fp).isDirectory()) continue;
        try {
          const nd = JSON.parse(fs.readFileSync(fp, "utf-8")) as { tree?: string; _type?: { _id?: string } };
          if (nd._type?._id === "InnerTreeEvaluatorNode" && nd.tree) childNames.add(nd.tree);
        } catch { /* skip unparseable node file */ }
      }
    }
    return { name, children: [...childNames].sort((a, b) => a.localeCompare(b)).map(build) };
  };
  return build(journeyName);
}

/** De-duped, sorted closure names from a dep tree. Excludes the root journey
 *  and `missing` entries — directly usable as additional report treeNames. */
export function flattenDepTree(root: JourneyDepNode): string[] {
  const out = new Set<string>();
  const walk = (n: JourneyDepNode) => {
    if (!n.missing && n.name !== root.name) out.add(n.name);
    for (const c of n.children) walk(c);
  };
  for (const c of root.children) walk(c);
  return [...out].sort((a, b) => a.localeCompare(b));
}
