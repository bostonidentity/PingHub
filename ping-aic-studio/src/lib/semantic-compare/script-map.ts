import fs from "fs";
import path from "path";
import { getRealmRoots } from "@/lib/realm-paths";

export function buildScriptMap(configDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const dir = path.join(realmRoot, "scripts", "scripts-config");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (j._id && j.name && j.context) {
          map.set(String(j._id), `${j.context}/${j.name}`);
        }
      } catch { /* skip malformed */ }
    }
  }
  return map;
}
