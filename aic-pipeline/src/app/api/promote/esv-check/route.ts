import { NextRequest, NextResponse } from "next/server";
import { runPromotePrecheck } from "@/lib/analyze/promote-precheck";
import type { ScopeSelection } from "@/lib/fr-config-types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sourceEnv = typeof body.sourceEnv === "string" ? body.sourceEnv : "";
  const targetEnv = typeof body.targetEnv === "string" ? body.targetEnv : "";
  const scopeSelections = Array.isArray(body.scopeSelections) ? (body.scopeSelections as ScopeSelection[]) : [];
  if (!sourceEnv || !targetEnv) {
    return NextResponse.json({ error: "Missing sourceEnv or targetEnv" }, { status: 400 });
  }
  try {
    const result = await runPromotePrecheck(sourceEnv, targetEnv, scopeSelections, req.signal);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
