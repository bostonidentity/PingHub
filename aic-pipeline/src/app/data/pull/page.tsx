// src/app/data/pull/page.tsx
import fs from "fs";
import path from "path";
import { getEnvironments, getConfigDir } from "@/lib/fr-config";
import { PullPanel } from "./PullPanel";

export default function DataPullPage() {
  const environments = getEnvironments();

  // Collect schema-defined types per env (union across envs is fine for MVP;
  // the panel shows whichever the selected env actually has).
  const typesByEnv: Record<string, string[]> = {};
  for (const e of environments) {
    const configDir = getConfigDir(e.name);
    if (!configDir) { typesByEnv[e.name] = []; continue; }
    const managedDir = path.join(configDir, "managed-objects");
    if (!fs.existsSync(managedDir)) { typesByEnv[e.name] = []; continue; }
    typesByEnv[e.name] = fs.readdirSync(managedDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  return <PullPanel environments={environments} typesByEnv={typesByEnv} />;
}
