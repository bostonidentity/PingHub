import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { getRealmRoots } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

type ScriptConfigEntry = { uuid: string; name: string; contextId?: string };

/** Read all scripts-config entries (uuid + name + contextId) across realms. */
function readScriptConfigs(configDir: string): ScriptConfigEntry[] {
  const out: ScriptConfigEntry[] = [];
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const scriptsConfigDir = path.join(realmRoot, "scripts", "scripts-config");
    for (const file of fs.readdirSync(scriptsConfigDir)) {
      const fp = path.join(scriptsConfigDir, file);
      try {
        const json = JSON.parse(fs.readFileSync(fp, "utf-8")) as { name?: string; context?: string };
        const uuid = path.basename(file, ".json");
        if (json.name) out.push({ uuid, name: json.name, contextId: json.context });
      } catch { /* skip */ }
    }
  }
  return out;
}

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

/** Escape a string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find scripts (in scripts-content/<type>/*) that import the target script via require("<name>"). */
function findScriptImporters(
  configDir: string,
  targetNames: string[],
  selfUuids: Set<string>,
  cfgByName: Map<string, ScriptConfigEntry[]>,
): { scriptName: string; scriptUuid: string; scriptType: string }[] {
  const matches: { scriptName: string; scriptUuid: string; scriptType: string }[] = [];
  if (targetNames.length === 0) return matches;

  // Match: require( "Name" ) or require( 'Name' )
  const namesAlt = targetNames.map(escapeRe).join("|");
  const requireRe = new RegExp(`require\\s*\\(\\s*['"](${namesAlt})['"]\\s*\\)`);

  const seen = new Set<string>();

  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-content")) {
    const contentRoot = path.join(realmRoot, "scripts", "scripts-content");
    if (!fs.existsSync(contentRoot)) continue;
    for (const typeDir of fs.readdirSync(contentRoot, { withFileTypes: true })) {
      if (!typeDir.isDirectory()) continue;
      const typeRoot = path.join(contentRoot, typeDir.name);
      for (const file of fs.readdirSync(typeRoot)) {
        const fp = path.join(typeRoot, file);
        try {
          if (!fs.statSync(fp).isFile()) continue;
          const text = fs.readFileSync(fp, "utf-8");
          if (!requireRe.test(text)) continue;
          const importerName = file.replace(/\.[^.]+$/, "");
          // Resolve importer uuid via scripts-config (may be more than one)
          const cfgs = cfgByName.get(importerName) ?? [];
          if (cfgs.length === 0) {
            const key = `${importerName}::${typeDir.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            matches.push({ scriptName: importerName, scriptUuid: "", scriptType: typeDir.name });
            continue;
          }
          for (const cfg of cfgs) {
            if (selfUuids.has(cfg.uuid)) continue; // skip self-reference
            const key = `${cfg.uuid}::${typeDir.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            matches.push({ scriptName: importerName, scriptUuid: cfg.uuid, scriptType: typeDir.name });
          }
        } catch { /* skip */ }
      }
    }
  }

  return matches;
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
    if (resolvedIds.length === 0) return NextResponse.json({ usedBy: [], usedByScripts: [] });
  }

  // Build name lookups for resolving target name and importer uuids.
  const allConfigs = readScriptConfigs(configDir);
  const cfgByName = new Map<string, ScriptConfigEntry[]>();
  for (const c of allConfigs) {
    const arr = cfgByName.get(c.name) ?? [];
    arr.push(c);
    cfgByName.set(c.name, arr);
  }

  // Determine target script names (for require(...) lookup) and self-uuids (to skip self).
  const targetNames = new Set<string>();
  const selfUuids = new Set<string>();
  if (scriptName) targetNames.add(scriptName);
  if (scriptId) {
    selfUuids.add(scriptId);
    for (const c of allConfigs) if (c.uuid === scriptId) targetNames.add(c.name);
  }
  if (resolvedIds) for (const id of resolvedIds) selfUuids.add(id);

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

  const usedByScripts = findScriptImporters(configDir, [...targetNames], selfUuids, cfgByName);

  return NextResponse.json({ usedBy, usedByScripts });
}
