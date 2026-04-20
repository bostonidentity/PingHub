import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { getRealmRoots } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

/**
 * Find journeys that reference the given journey as an inner journey.
 * An inner-journey reference is a node with `_type._id === "InnerTreeEvaluatorNode"`
 * whose `tree` property equals the target journey name.
 */
export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env");
  const journeyName = req.nextUrl.searchParams.get("journeyName");

  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });
  if (!journeyName) return NextResponse.json({ error: "journeyName required" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir) return NextResponse.json({ error: "Config dir not found" }, { status: 404 });

  const usedBy: {
    journey: string;
    nodeName: string;
    nodeType: string;
    nodeUuid: string;
  }[] = [];

  for (const realmRoot of getRealmRoots(configDir, "journeys")) {
    const journeysDir = path.join(realmRoot, "journeys");
    for (const jDir of fs.readdirSync(journeysDir, { withFileTypes: true })) {
      if (!jDir.isDirectory()) continue;
      if (jDir.name === journeyName) continue; // skip self
      const nodesDir = path.join(journeysDir, jDir.name, "nodes");
      if (!fs.existsSync(nodesDir)) continue;

      for (const nf of fs.readdirSync(nodesDir)) {
        const fp = path.join(nodesDir, nf);
        if (fs.statSync(fp).isDirectory()) continue;
        try {
          const nd = JSON.parse(fs.readFileSync(fp, "utf-8")) as {
            tree?: string;
            _type?: { _id?: string; name?: string };
          };
          if (nd._type?._id !== "InnerTreeEvaluatorNode") continue;
          if (nd.tree !== journeyName) continue;
          const nodeUuidMatch = nf.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i);
          usedBy.push({
            journey: jDir.name,
            nodeName: nd._type?.name ?? nf.replace(/\s*-\s*[0-9a-f-]+\.json$/i, ""),
            nodeType: nd._type?._id ?? "InnerTreeEvaluatorNode",
            nodeUuid: nodeUuidMatch?.[1] ?? "",
          });
        } catch { /* skip */ }
      }
    }
  }

  return NextResponse.json({ usedBy });
}
