import { NextRequest, NextResponse } from "next/server";
import { readTasks, createTask } from "@/lib/promotion-tasks";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readTasks());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.name || !body.source || !body.target) {
    return NextResponse.json({ error: "name, source, and target are required" }, { status: 400 });
  }
  const task = createTask({
    name: body.name,
    description: body.description ?? "",
    status: "new",
    source: body.source,
    target: body.target,
    items: body.items ?? [],
  });
  return NextResponse.json(task, { status: 201 });
}
