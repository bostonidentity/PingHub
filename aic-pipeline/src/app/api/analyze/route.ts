import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { getRealmRoots } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

export interface JourneyInfo {
  name: string;
  enabled: boolean;
  innerTreeOnly: boolean;
  nodeCount: number;
  subJourneys: string[];   // journeys this one calls
  calledBy: string[];      // journeys that call this one (computed)
}

export interface ScriptUsage {
  uuid: string;
  name: string;
  context: string;
  usedBy: { journey: string; nodeName: string; nodeType: string }[];
}

export interface AnalyzeSummary {
  total: number;
  roots: number;
  orphaned: number;
  sharedSubJourneys: number;
  maxDepth: number;
  mostCalled: { name: string; count: number }[];
}

export interface AnalyzeResult {
  journeys: JourneyInfo[];
  summary: AnalyzeSummary;
  scriptUsage: ScriptUsage[];
}

function getDepth(name: string, map: Map<string, JourneyInfo>, visited = new Set<string>()): number {
  if (visited.has(name)) return 0; // cycle guard
  visited.add(name);
  const info = map.get(name);
  if (!info || info.subJourneys.length === 0) return 0;
  return 1 + Math.max(...info.subJourneys.map((s) => getDepth(s, map, new Set(visited))));
}

export async function POST(req: NextRequest) {
  const { env } = await req.json();
  if (!env) return NextResponse.json({ error: "env is required" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "No config dir for environment." }, { status: 400 });

  const journeyRealmRoots = getRealmRoots(configDir, "journeys");
  if (journeyRealmRoots.length === 0) {
    return NextResponse.json({ error: "No journeys found — pull config first." }, { status: 404 });
  }

  const journeyMap = new Map<string, JourneyInfo>();
  const scriptReverseIndex = new Map<string, { journey: string; nodeName: string; nodeType: string }[]>();

  for (const realmRoot of journeyRealmRoots) {
    const journeysDir = path.join(realmRoot, "journeys");
    for (const journeyName of fs.readdirSync(journeysDir)) {
      const journeyDir = path.join(journeysDir, journeyName);
      const stat = fs.statSync(journeyDir);
      if (!stat.isDirectory()) continue;

      const mainFile = path.join(journeyDir, `${journeyName}.json`);
      if (!fs.existsSync(mainFile)) continue;

      let journeyData: Record<string, unknown>;
      try {
        journeyData = JSON.parse(fs.readFileSync(mainFile, "utf-8"));
      } catch {
        continue;
      }

      const nodes = (journeyData.nodes ?? {}) as Record<string, { nodeType?: string }>;
      const nodeCount = Object.keys(nodes).length;

      // Collect UUIDs of InnerTreeEvaluatorNode nodes
      const innerTreeUUIDs = new Set<string>();
      for (const [uuid, node] of Object.entries(nodes)) {
        if (node.nodeType === "InnerTreeEvaluatorNode") innerTreeUUIDs.add(uuid);
      }

      // Read node files to resolve sub-journeys and collect script references
      const subJourneys: string[] = [];
      const nodeScriptRefs: { scriptUuid: string; nodeName: string; nodeType: string }[] = [];
      const nodesDir = path.join(journeyDir, "nodes");
      if (fs.existsSync(nodesDir)) {
        for (const nodeFile of fs.readdirSync(nodesDir)) {
          const fp = path.join(nodesDir, nodeFile);
          if (fs.statSync(fp).isDirectory()) continue;
          // Accept both "NodeType - uuid.json" and "NodeType_-_uuid.json" filename conventions.
          const uuidMatch = nodeFile.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i);
          try {
            const nodeData = JSON.parse(fs.readFileSync(fp, "utf-8")) as {
              tree?: string; script?: string; _type?: { _id?: string; name?: string };
            };
            if (uuidMatch && innerTreeUUIDs.has(uuidMatch[1]) && nodeData.tree) {
              subJourneys.push(nodeData.tree);
            }
            if (nodeData.script) {
              nodeScriptRefs.push({
                scriptUuid: nodeData.script,
                nodeName: nodeData._type?.name ?? nodeFile.replace(/\s*-\s*[0-9a-f-]+\.json$/i, ""),
                nodeType: nodeData._type?._id ?? "unknown",
              });
            }
          } catch { /* skip malformed file */ }
        }
      }

      journeyMap.set(journeyName, {
        name: journeyName,
        enabled: (journeyData.enabled as boolean) ?? true,
        innerTreeOnly: (journeyData.innerTreeOnly as boolean) ?? false,
        nodeCount,
        subJourneys,
        calledBy: [],
      });

      // Store script refs for later reverse-index building
      for (const ref of nodeScriptRefs) {
        if (!scriptReverseIndex.has(ref.scriptUuid)) scriptReverseIndex.set(ref.scriptUuid, []);
        scriptReverseIndex.get(ref.scriptUuid)!.push({ journey: journeyName, nodeName: ref.nodeName, nodeType: ref.nodeType });
      }
    }
  }

  // Build reverse index: calledBy
  for (const info of journeyMap.values()) {
    for (const sub of info.subJourneys) {
      const target = journeyMap.get(sub);
      if (target) target.calledBy.push(info.name);
    }
  }

  const journeys = Array.from(journeyMap.values());

  // Derive summary
  const roots     = journeys.filter((j) => j.calledBy.length === 0 && !j.innerTreeOnly);
  const orphaned  = journeys.filter((j) => j.calledBy.length === 0 && j.innerTreeOnly);
  const sharedSubs = journeys.filter((j) => j.calledBy.length >= 2);
  const maxDepth  = roots.length > 0
    ? Math.max(...roots.map((r) => getDepth(r.name, journeyMap)))
    : 0;
  const mostCalled = [...journeys]
    .filter((j) => j.calledBy.length > 0)
    .sort((a, b) => b.calledBy.length - a.calledBy.length)
    .slice(0, 8)
    .map((j) => ({ name: j.name, count: j.calledBy.length }));

  // Build script usage from reverse index + script configs
  const scriptUsage: ScriptUsage[] = [];
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const configPath = path.join(realmRoot, "scripts", "scripts-config");
    for (const f of fs.readdirSync(configPath)) {
      if (!f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(configPath, f), "utf-8"));
        const uuid = data._id as string;
        const name = (data.name as string) ?? uuid;
        const context = (data.context as string) ?? "";
        const usedBy = scriptReverseIndex.get(uuid) ?? [];
        scriptUsage.push({ uuid, name, context, usedBy });
      } catch { /* skip */ }
    }
  }
  scriptUsage.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    journeys,
    summary: { total: journeys.length, roots: roots.length, orphaned: orphaned.length, sharedSubJourneys: sharedSubs.length, maxDepth, mostCalled },
    scriptUsage,
  } satisfies AnalyzeResult);
}
