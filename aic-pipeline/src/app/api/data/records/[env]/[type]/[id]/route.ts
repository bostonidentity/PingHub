import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { cwd } from "process";
import { readRecord } from "@/lib/data/snapshot-fs";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ env: string; type: string; id: string }> },
) {
  const { env, type, id } = await params;
  const record = await readRecord(path.join(cwd(), "environments"), env, type, id);
  if (!record) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id, record });
}
