import { NextRequest, NextResponse } from "next/server";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { readManifest } from "@/lib/logs/manifest";

export const dynamic = "force-dynamic";

/** GET /api/logs/archive/manifest?env=prod — covered-range coverage per source. */
export async function GET(req: NextRequest) {
    const env = req.nextUrl.searchParams.get("env");
    if (!env) return NextResponse.json({ error: "env is required" }, { status: 400 });
    return NextResponse.json({ manifest: readManifest(logDataDir(env)) });
}
