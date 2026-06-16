import { NextResponse } from "next/server";
import { resumeSchedule } from "@/lib/scheduler/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  resumeSchedule(id);
  return NextResponse.json({ ok: true });
}
