import { NextRequest, NextResponse } from "next/server";

import { listSamlProviders } from "@/lib/federation/saml";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const environment = req.nextUrl.searchParams.get("environment");
  const realm = req.nextUrl.searchParams.get("realm") || "alpha";
  const query = req.nextUrl.searchParams.get("query") || "";
  const sourceRaw = req.nextUrl.searchParams.get("source") || "live";
  const pageSizeRaw = Number(req.nextUrl.searchParams.get("pageSize") || "50");
  const source = sourceRaw === "local" ? "local" : "live";
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 200) : 50;

  if (!environment) return NextResponse.json({ error: "Missing environment" }, { status: 400 });

  try {
    const providers = await listSamlProviders({ environment, realm, query, source, pageSize });
    return NextResponse.json({ providers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
