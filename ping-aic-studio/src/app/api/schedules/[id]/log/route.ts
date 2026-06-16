import { NextResponse } from "next/server";
import { getLog } from "@/lib/scheduler/log-buffer";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0") || 0;
  const log = getLog(id, since);
  if (!log) return NextResponse.json({ running: false, exitCode: null, events: [], cursor: since });
  return NextResponse.json(log);
}
