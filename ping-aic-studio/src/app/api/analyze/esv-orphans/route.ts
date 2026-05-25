import { NextRequest, NextResponse } from "next/server";
import { runEsvOrphans } from "@/lib/analyze/esv-orphans";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const env = typeof body.env === "string" ? body.env : "";
  if (!env) return NextResponse.json({ error: "Missing env" }, { status: 400 });
  try {
    const result = await runEsvOrphans(env, req.signal);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
