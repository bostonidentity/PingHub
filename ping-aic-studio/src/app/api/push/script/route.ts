import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { findRealmContaining } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const environment = searchParams.get("environment");
  const scriptId    = searchParams.get("scriptId");

  if (!environment || !scriptId) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  const configDir = getConfigDir(environment);
  if (!configDir) return NextResponse.json({ error: "Config dir not found" }, { status: 404 });

  const realmRoot = findRealmContaining(configDir, path.join("scripts", "scripts-config", `${scriptId}.json`));
  if (!realmRoot) return NextResponse.json({ error: "Script not found" }, { status: 404 });

  const configFile = path.join(realmRoot, "scripts", "scripts-config", `${scriptId}.json`);
  let scriptMeta: { name?: string; script?: { file?: string } };
  try {
    scriptMeta = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  } catch {
    return NextResponse.json({ error: "Script config unreadable" }, { status: 500 });
  }

  const relFile = scriptMeta.script?.file;
  if (!relFile) {
    return NextResponse.json({ name: scriptMeta.name ?? scriptId, content: null, filename: null });
  }

  const contentFile = path.join(realmRoot, "scripts", relFile);
  if (!fs.existsSync(contentFile)) {
    return NextResponse.json({ name: scriptMeta.name ?? scriptId, content: null, filename: path.basename(relFile) });
  }

  const content = fs.readFileSync(contentFile, "utf-8");
  return NextResponse.json({ name: scriptMeta.name ?? scriptId, content, filename: path.basename(relFile) });
}
