import { NextRequest, NextResponse } from "next/server";
import { setEnvSkipped } from "@/lib/rcs/env-skiplist";

interface Body {
  env?: string;
  skip?: boolean;
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as Body;
  const { env, skip } = body;
  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });
  if (typeof skip !== "boolean") {
    return NextResponse.json({ error: "skip must be a boolean" }, { status: 400 });
  }
  setEnvSkipped(env, skip);
  return NextResponse.json({ ok: true });
}
