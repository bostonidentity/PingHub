import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { getRealmRoots } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

/** Resolve script UUID(s) from a human-readable name by scanning scripts-config dirs. */
function resolveScriptIdsByName(configDir: string, scriptName: string): string[] {
  const ids: string[] = [];
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const scriptsConfigDir = path.join(realmRoot, "scripts", "scripts-config");
    for (const file of fs.readdirSync(scriptsConfigDir)) {
      const fp = path.join(scriptsConfigDir, file);
      try {
        const json = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (json.name === scriptName) {
          const uuid = path.basename(file, ".json");
          if (!ids.includes(uuid)) ids.push(uuid);
        }
      } catch { /* skip */ }
    }
  }
  return ids;
}

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env");
  const scriptId = req.nextUrl.searchParams.get("scriptId");
  const scriptName = req.nextUrl.searchParams.get("scriptName");

  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "Config dir not found" }, { status: 404 });

  let resolvedIds: string[] | null = null;
  if (!scriptId && scriptName) {
    resolvedIds = resolveScriptIdsByName(configDir, scriptName);
    if (resolvedIds.length === 0) return NextResponse.json({ usedBy: [] });
  }

  const usedBy: { journey: string; nodeName: string; nodeType: string; nodeUuid: string; scriptUuid: string; scriptName: string }[] = [];

  for (const realmRoot of getRealmRoots(configDir, "journeys")) {
    const journeysDir = path.join(realmRoot, "journeys");
    for (const jDir of fs.readdirSync(journeysDir, { withFileTypes: true })) {
      if (!jDir.isDirectory()) continue;
      const nodesDir = path.join(journeysDir, jDir.name, "nodes");
      if (!fs.existsSync(nodesDir)) continue;

      for (const nf of fs.readdirSync(nodesDir)) {
        const fp = path.join(nodesDir, nf);
        if (fs.statSync(fp).isDirectory()) continue;
        try {
          const nd = JSON.parse(fs.readFileSync(fp, "utf-8")) as {
            script?: string;
            _type?: { _id?: string; name?: string };
          };
          if (!nd.script) continue;
          if (scriptId && nd.script !== scriptId) continue;
          if (!scriptId && resolvedIds && !resolvedIds.includes(nd.script)) continue;
          const nodeUuidMatch = nf.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i);
          usedBy.push({
            journey: jDir.name,
            nodeName: nd._type?.name ?? nf.replace(/\s*-\s*[0-9a-f-]+\.json$/i, ""),
            nodeType: nd._type?._id ?? "unknown",
            nodeUuid: nodeUuidMatch?.[1] ?? "",
            scriptUuid: nd.script,
            scriptName: "",
          });
        } catch { /* skip */ }
      }
    }
  }

  return NextResponse.json({ usedBy });
}
