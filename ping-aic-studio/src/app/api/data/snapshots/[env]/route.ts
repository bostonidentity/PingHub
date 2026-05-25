import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { cwd } from "process";
import { listSnapshotTypes } from "@/lib/data/snapshot-fs";
import { ENVIRONMENTS_DIR } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  const types = await listSnapshotTypes(ENVIRONMENTS_DIR, env);
  return NextResponse.json({ types });
}
