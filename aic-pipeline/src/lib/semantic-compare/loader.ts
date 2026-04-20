import fs from "fs";
import path from "path";
import { getRealmRoots } from "@/lib/realm-paths";
import type { CanonicalJourney, CanonicalScript } from "./types";
import { canonicalizeScript } from "./script-canon";
import { canonicalizeJourney } from "./journey-canon";
import { buildScriptMap } from "./script-map";

export interface CanonicalEnv {
  scripts: Map<string, CanonicalScript>;
  journeys: Map<string, CanonicalJourney>;
}

export function loadCanonicalEnv(configDir: string): CanonicalEnv {
  const scripts = new Map<string, CanonicalScript>();
  const journeys = new Map<string, CanonicalJourney>();

  // Scripts
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const cfgDir = path.join(realmRoot, "scripts", "scripts-config");
    const contentRoot = path.join(realmRoot, "scripts");
    for (const f of fs.readdirSync(cfgDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf-8"));
        const bodyPath = cfg.script?.file ? path.join(contentRoot, cfg.script.file) : null;
        const body = bodyPath && fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath, "utf-8") : "";
        const s = canonicalizeScript(cfg, body);
        scripts.set(s.identity, s);
      } catch { /* skip */ }
    }
  }

  // Journeys
  const scriptMap = buildScriptMap(configDir);
  for (const realmRoot of getRealmRoots(configDir, "journeys")) {
    const jRoot = path.join(realmRoot, "journeys");
    for (const dir of fs.readdirSync(jRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const name = dir.name;
      const jDir = path.join(jRoot, name);
      const main = path.join(jDir, `${name}.json`);
      if (!fs.existsSync(main)) continue;
      try {
        const tree = JSON.parse(fs.readFileSync(main, "utf-8"));
        const nodeFiles: Record<string, Record<string, unknown>> = {};

        // Load node files from a sibling `nodes/` subdir if present,
        // otherwise load any .json file in the journey dir itself (excluding the main file).
        const nodesDir = path.join(jDir, "nodes");
        const scanDir = fs.existsSync(nodesDir) ? nodesDir : jDir;
        for (const nf of fs.readdirSync(scanDir)) {
          if (!nf.endsWith(".json")) continue;
          if (scanDir === jDir && nf === `${name}.json`) continue;
          try {
            const node = JSON.parse(
              fs.readFileSync(path.join(scanDir, nf), "utf-8"),
            );
            // Prefer node._id when present (real data), else use filename stem (tests).
            const key =
              typeof node._id === "string"
                ? node._id
                : nf.replace(/\.json$/i, "");
            nodeFiles[key] = node;
          } catch { /* skip */ }
        }

        journeys.set(name, canonicalizeJourney(name, tree, nodeFiles, scriptMap));
      } catch { /* skip */ }
    }
  }

  return { scripts, journeys };
}
