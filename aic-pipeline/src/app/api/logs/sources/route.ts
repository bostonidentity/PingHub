import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env");
  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });

  const creds = getLogApiCredentials(env);
  if (!creds) return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });

  const vars = parseEnvFile(getEnvFileContent(env));
  const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
  if (!tenantBaseUrl) return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });

  try {
    const res = await fetch(`${tenantBaseUrl}/monitoring/logs/sources`, {
      headers: {
        "x-api-key": creds.apiKey,
        "x-api-secret": creds.apiSecret,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json({ error: `HTTP ${res.status}: ${body}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
