import { NextResponse } from "next/server";
import { listSchedules, createSchedule } from "@/lib/scheduler/store";
import { validateTrigger } from "@/lib/scheduler/cron";
import type { ScheduleInput } from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listSchedules());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ScheduleInput | null;
  if (!body || !body.name || !Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json({ error: "name and at least one step are required" }, { status: 400 });
  }
  const triggerErr = validateTrigger(body.trigger);
  if (triggerErr) return NextResponse.json({ error: `Invalid trigger: ${triggerErr}` }, { status: 400 });
  const created = createSchedule(body);
  return NextResponse.json(created, { status: 201 });
}
