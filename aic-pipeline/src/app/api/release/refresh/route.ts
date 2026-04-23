import { NextRequest, NextResponse } from "next/server";
import { refreshOne } from "@/lib/release/refresh";

/**
 * Force-refresh release info for a single env. The app's UI no longer calls
 * this — release data is refreshed automatically once per UTC day as pages
 * are viewed. Kept as an ops escape hatch (e.g. curl from a shell).
 */
export async function POST(req: NextRequest) {
  const { env } = (await req.json()) as { env?: string };
  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });
  const entry = await refreshOne(env);
  if (entry.error) return NextResponse.json(entry, { status: 502 });
  return NextResponse.json(entry);
}
