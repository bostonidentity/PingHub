import { NextRequest, NextResponse } from "next/server";

import { realmsForEnvironment } from "@/lib/federation/saml";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const environment = req.nextUrl.searchParams.get("environment");
  if (!environment) return NextResponse.json({ error: "Missing environment" }, { status: 400 });

  try {
    return NextResponse.json({ realms: realmsForEnvironment(environment) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
