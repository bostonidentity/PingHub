import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { getRealmRoots } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

interface JourneyDep {
  name: string;
  scripts: { uuid: string; name: string }[];
  subJourneys: string[];
}

function scanJourneyDeps(configDir: string, journeyName: string, visited: Set<string> = new Set()): JourneyDep[] {
  if (visited.has(journeyName)) return [];
  visited.add(journeyName);

  const deps: JourneyDep[] = [];

  for (const realmRoot of getRealmRoots(configDir, path.join("journeys", journeyName))) {
    const journeyDir = path.join(realmRoot, "journeys", journeyName);
    const nodesDir = path.join(journeyDir, "nodes");
    const scripts: { uuid: string; name: string }[] = [];
    const subJourneys: string[] = [];

    if (fs.existsSync(nodesDir)) {
      // Build script UUID → name map
      const scriptNameMap = new Map<string, string>();
      const scriptsConfigDir = path.join(realmRoot, "scripts", "scripts-config");
      if (fs.existsSync(scriptsConfigDir)) {
        for (const f of fs.readdirSync(scriptsConfigDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            const json = JSON.parse(fs.readFileSync(path.join(scriptsConfigDir, f), "utf-8"));
            if (json._id && json.name) scriptNameMap.set(json._id, json.name);
          } catch { /* skip */ }
        }
      }

      for (const nf of fs.readdirSync(nodesDir)) {
        const fp = path.join(nodesDir, nf);
        if (fs.statSync(fp).isDirectory()) continue;
        try {
          const nd = JSON.parse(fs.readFileSync(fp, "utf-8")) as {
            script?: string;
            tree?: string;
            _type?: { _id?: string };
          };
          if (nd.script) {
            const name = scriptNameMap.get(nd.script) ?? nd.script;
            if (!scripts.find((s) => s.uuid === nd.script)) {
              scripts.push({ uuid: nd.script, name });
            }
          }
          if (nd._type?._id === "InnerTreeEvaluatorNode" && nd.tree) {
            if (!subJourneys.includes(nd.tree)) subJourneys.push(nd.tree);
          }
        } catch { /* skip */ }
      }
    }

    deps.push({ name: journeyName, scripts, subJourneys });

    // Recurse into sub-journeys
    for (const sub of subJourneys) {
      deps.push(...scanJourneyDeps(configDir, sub, visited));
    }
  }

  return deps;
}

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env");
  const journey = req.nextUrl.searchParams.get("journey");

  if (!env || !journey) {
    return NextResponse.json({ error: "env and journey required" }, { status: 400 });
  }

  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "Config dir not found" }, { status: 404 });

  const deps = scanJourneyDeps(configDir, journey);

  // Flatten all unique scripts and sub-journeys
  const allScripts = new Map<string, string>();
  const allSubJourneys = new Set<string>();
  for (const dep of deps) {
    for (const s of dep.scripts) allScripts.set(s.uuid, s.name);
    for (const sj of dep.subJourneys) allSubJourneys.add(sj);
  }

  return NextResponse.json({
    journey,
    deps,
    allScripts: Array.from(allScripts.entries()).map(([uuid, name]) => ({ uuid, name })),
    allSubJourneys: Array.from(allSubJourneys),
  });
}
