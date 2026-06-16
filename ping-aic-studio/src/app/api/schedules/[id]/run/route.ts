import { NextResponse } from "next/server";
import { runSchedule } from "@/lib/scheduler/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const status = await runSchedule(id);
  return NextResponse.json({ status });
}
