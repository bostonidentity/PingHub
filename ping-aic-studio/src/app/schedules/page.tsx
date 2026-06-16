import fs from "fs";
import path from "path";
import { getEnvironments, getConfigDir } from "@/lib/fr-config";
import { ScheduleList } from "./ScheduleList";

export const dynamic = "force-dynamic";

export default function SchedulerPage() {
  const environments = getEnvironments();

  // Discover the managed-object types available per env (same mechanism as the
  // Data Pull page), so the editor can offer them for a pull-data step.
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

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Scheduler</h1>
      <ScheduleList environments={environments} typesByEnv={typesByEnv} />
    </main>
  );
}
