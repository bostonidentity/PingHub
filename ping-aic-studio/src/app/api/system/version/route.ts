import { NextResponse } from "next/server";
import { getVersionStatus } from "@/lib/system-update";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const status = await getVersionStatus(force);
  return NextResponse.json(status);
}
