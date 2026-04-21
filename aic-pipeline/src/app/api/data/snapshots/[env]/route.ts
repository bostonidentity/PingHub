import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { cwd } from "process";
import { listSnapshotTypes } from "@/lib/data/snapshot-fs";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  const types = listSnapshotTypes(path.join(cwd(), "environments"), env);
  return NextResponse.json({ types });
}
