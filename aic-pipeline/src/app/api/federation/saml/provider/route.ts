import { NextRequest, NextResponse } from "next/server";

import { getSamlProvider } from "@/lib/federation/saml";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const environment = req.nextUrl.searchParams.get("environment");
  const realm = req.nextUrl.searchParams.get("realm") || "alpha";
  const location = req.nextUrl.searchParams.get("location");
  const id = req.nextUrl.searchParams.get("id");
  const entityId = req.nextUrl.searchParams.get("entityId") || id || "";
  const sourceRaw = req.nextUrl.searchParams.get("source") || "live";
  const source = sourceRaw === "local" ? "local" : "live";

  if (!environment) return NextResponse.json({ error: "Missing environment" }, { status: 400 });
  if (!location) return NextResponse.json({ error: "Missing location" }, { status: 400 });
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const provider = await getSamlProvider({ environment, realm, location, id, entityId, source });
    if (!provider) return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    return NextResponse.json({ provider });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
