// src/app/api/data/titles/[env]/route.ts
//
// Batch-resolve display titles for a list of (type, id) refs using the
// caller-chosen attribute per type. Used by the data-tab deps panel.

import { NextRequest, NextResponse } from "next/server";
import { resolveTitles, type ResolveTitlesResult, type TitleRef } from "@/lib/data/snapshot-fs";
import { ENVIRONMENTS_DIR } from "@/lib/paths";

export const dynamic = "force-dynamic";

export interface TitlesRequest {
  refs: TitleRef[];
  attrs: Record<string, string>;
}

export type TitlesResponse = ResolveTitlesResult;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  let body: TitlesRequest;
  try { body = await req.json() as TitlesRequest; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!Array.isArray(body.refs)) {
    return NextResponse.json({ error: "refs must be an array" }, { status: 400 });
  }
  const out = await resolveTitles(
    ENVIRONMENTS_DIR, env, body.refs, body.attrs ?? {},
  );
  return NextResponse.json(out satisfies TitlesResponse);
}
