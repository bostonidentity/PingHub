import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { findRealmContaining } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const environment = searchParams.get("environment");
  const journey     = searchParams.get("journey");
  const nodeId      = searchParams.get("nodeId");

  if (!environment || !journey || !nodeId) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  const configDir = getConfigDir(environment);
  if (!configDir) return NextResponse.json({ error: "Config dir not found" }, { status: 404 });

  const realmRoot = findRealmContaining(configDir, path.join("journeys", journey, "nodes"));
  if (!realmRoot) return NextResponse.json({ error: "Node file not found" }, { status: 404 });

  const nodesDir = path.join(realmRoot, "journeys", journey, "nodes");
  const match = fs.readdirSync(nodesDir).find((f) => f.includes(nodeId) && f.endsWith(".json"));
  if (!match) return NextResponse.json({ error: "Node file not found" }, { status: 404 });

  const content = fs.readFileSync(path.join(nodesDir, match), "utf-8");
  return NextResponse.json({ file: { name: match, content, language: "json" } });
}
