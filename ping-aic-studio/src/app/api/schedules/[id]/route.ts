import { NextResponse } from "next/server";
import { getSchedule, updateSchedule, deleteSchedule } from "@/lib/scheduler/store";
import { validateTrigger } from "@/lib/scheduler/cron";
import type { ScheduleInput } from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const s = getSchedule(id);
  return s ? NextResponse.json(s) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const patch = (await req.json().catch(() => ({}))) as Partial<ScheduleInput>;
  if (patch.trigger) {
    const err = validateTrigger(patch.trigger);
    if (err) return NextResponse.json({ error: `Invalid trigger: ${err}` }, { status: 400 });
  }
  const updated = updateSchedule(id, patch);
  return updated ? NextResponse.json(updated) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  deleteSchedule(id);
  return NextResponse.json({ ok: true });
}
