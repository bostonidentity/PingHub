import { NextResponse } from "next/server";
import { pauseSchedule } from "@/lib/scheduler/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  pauseSchedule(id);
  return NextResponse.json({ ok: true });
}
