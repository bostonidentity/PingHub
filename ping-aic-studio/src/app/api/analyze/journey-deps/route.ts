import { NextRequest, NextResponse } from "next/server";
import { getEnvironments, getConfigDir } from "@/lib/fr-config";
import { resolveJourneyDepTree, flattenDepTree } from "@/lib/resolve-journey-deps";

export const dynamic = "force-dynamic";

/** GET /api/analyze/journey-deps?env=prod&journey=MasterLogin
 *  → { tree: JourneyDepNode, flat: string[] } — the journey's inner-journey
 *  closure from pulled config, for the report's inner-journey picker. */
export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env") ?? "";
  const journey = req.nextUrl.searchParams.get("journey") ?? "";
  if (!env || !getEnvironments().some((e) => e.name === env)) {
    return NextResponse.json({ error: "unknown environment" }, { status: 400 });
  }
  if (!journey) {
    return NextResponse.json({ error: "journey is required" }, { status: 400 });
  }
  const configDir = getConfigDir(env);
  if (!configDir) {
    return NextResponse.json({ error: "no pulled config for environment" }, { status: 404 });
  }
  const tree = resolveJourneyDepTree(configDir, journey);
  if (tree.missing) {
    return NextResponse.json({ error: "journey not found in config" }, { status: 404 });
  }
  return NextResponse.json({ tree, flat: flattenDepTree(tree) });
}
