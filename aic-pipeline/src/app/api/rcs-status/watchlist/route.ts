import { NextRequest, NextResponse } from "next/server";
import { writeWatchlistEntry } from "@/lib/rcs/watchlist";

interface Body {
  env?: string;
  cluster?: string;
  include?: string[] | null;
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as Body;
  const { env, cluster, include } = body;
  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });
  if (!cluster) return NextResponse.json({ error: "cluster required" }, { status: 400 });
  if (include !== null && !Array.isArray(include)) {
    return NextResponse.json({ error: "include must be an array of strings or null" }, { status: 400 });
  }
  if (Array.isArray(include) && !include.every((s) => typeof s === "string")) {
    return NextResponse.json({ error: "include must contain strings" }, { status: 400 });
  }
  writeWatchlistEntry(env, cluster, include);
  return NextResponse.json({ ok: true });
}
