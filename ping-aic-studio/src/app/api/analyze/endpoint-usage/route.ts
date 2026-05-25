import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { getRealmRoots } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

export interface EndpointUsageRef {
  type: "script" | "workflow" | "endpoint";
  /** type = "script" */
  scriptId?: string;
  scriptName?: string;
  /** type = "workflow" */
  workflowId?: string;
  stepFile?: string;
  /** type = "endpoint" */
  endpointId?: string;
}

/** Resolve script UUID + name from content file name + context directory. */
function resolveScriptByName(
  configDir: string,
  scriptName: string,
  context: string,
): { id: string; name: string } | null {
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-config")) {
    const scriptsConfigDir = path.join(realmRoot, "scripts", "scripts-config");
    for (const file of fs.readdirSync(scriptsConfigDir)) {
      const fp = path.join(scriptsConfigDir, file);
      try {
        const json = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (json.name === scriptName && json.context === context) {
          return { id: path.basename(file, ".json"), name: json.name };
        }
      } catch { /* skip */ }
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env");
  const endpointName = req.nextUrl.searchParams.get("endpointName");

  if (!env || !endpointName) {
    return NextResponse.json({ error: "env and endpointName required" }, { status: 400 });
  }

  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "Config dir not found" }, { status: 404 });

  const pattern = `endpoint/${endpointName}`;
  const usedBy: EndpointUsageRef[] = [];

  // ── 1. Journey scripts ─────────────────────────────────────────────────────
  for (const realmRoot of getRealmRoots(configDir, "scripts/scripts-content")) {
    const scriptsContentDir = path.join(realmRoot, "scripts", "scripts-content");
    for (const ctxEntry of fs.readdirSync(scriptsContentDir, { withFileTypes: true })) {
      if (!ctxEntry.isDirectory()) continue;
      const ctxDir = path.join(scriptsContentDir, ctxEntry.name);

      for (const sf of fs.readdirSync(ctxDir, { withFileTypes: true })) {
        if (!sf.isFile()) continue;
        const fp = path.join(ctxDir, sf.name);
        try {
          const content = fs.readFileSync(fp, "utf-8");
          if (!content.includes(pattern)) continue;
          const scriptName = path.basename(sf.name, path.extname(sf.name));
          const resolved = resolveScriptByName(configDir, scriptName, ctxEntry.name);
          if (resolved && !usedBy.some((r) => r.type === "script" && r.scriptId === resolved.id)) {
            usedBy.push({ type: "script", scriptId: resolved.id, scriptName: resolved.name });
          }
        } catch { /* skip */ }
      }
    }
  }

  // ── 2. IGA workflow step scripts ───────────────────────────────────────────
  const workflowsDir = path.join(configDir, "iga", "workflows");
  if (fs.existsSync(workflowsDir)) {
    for (const wf of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!wf.isDirectory()) continue;
      const stepsDir = path.join(workflowsDir, wf.name, "steps");
      if (!fs.existsSync(stepsDir)) continue;

      outer: for (const stepDir of fs.readdirSync(stepsDir, { withFileTypes: true })) {
        if (!stepDir.isDirectory()) continue;
        const stepDirPath = path.join(stepsDir, stepDir.name);
        for (const sf of fs.readdirSync(stepDirPath, { withFileTypes: true })) {
          if (!sf.isFile() || !sf.name.endsWith(".js")) continue;
          try {
            const content = fs.readFileSync(path.join(stepDirPath, sf.name), "utf-8");
            if (content.includes(pattern)) {
              if (!usedBy.some((r) => r.type === "workflow" && r.workflowId === wf.name)) {
                usedBy.push({ type: "workflow", workflowId: wf.name, stepFile: sf.name });
              }
              break outer;
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  // ── 3. Other endpoint scripts ──────────────────────────────────────────────
  const endpointsDir = path.join(configDir, "endpoints");
  if (fs.existsSync(endpointsDir)) {
    for (const ep of fs.readdirSync(endpointsDir, { withFileTypes: true })) {
      if (!ep.isDirectory() || ep.name === endpointName) continue;
      const epDir = path.join(endpointsDir, ep.name);
      for (const sf of fs.readdirSync(epDir, { withFileTypes: true })) {
        if (!sf.isFile() || !sf.name.endsWith(".js")) continue;
        try {
          const content = fs.readFileSync(path.join(epDir, sf.name), "utf-8");
          if (content.includes(pattern)) {
            usedBy.push({ type: "endpoint", endpointId: ep.name });
            break;
          }
        } catch { /* skip */ }
      }
    }
  }

  return NextResponse.json({ usedBy });
}
