import { NextResponse } from "next/server";
import { stopSchedule } from "@/lib/scheduler/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  stopSchedule(id);
  return NextResponse.json({ ok: true });
}
