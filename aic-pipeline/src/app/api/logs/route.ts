import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { env, source, beginTime, endTime, pageSize = 1000, cookie, tail = false, transactionId, queryFilter } = body as {
    env: string;
    source: string;
    beginTime?: string;
    endTime?: string;
    pageSize?: number;
    cookie?: string;
    tail?: boolean;
    transactionId?: string;
    queryFilter?: string;
  };

  if (!env || !source) {
    return NextResponse.json({ error: "env and source are required." }, { status: 400 });
  }
  if (!tail && !beginTime && !transactionId) {
    return NextResponse.json({ error: "beginTime or transactionId is required for non-tail requests." }, { status: 400 });
  }

  const creds = getLogApiCredentials(env);
  if (!creds) return NextResponse.json({ error: "No Log API credentials configured." }, { status: 400 });

  const vars = parseEnvFile(getEnvFileContent(env));
  const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
  if (!tenantBaseUrl) return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });

  const authHeaders = {
    "x-api-key": creds.apiKey,
    "x-api-secret": creds.apiSecret,
  };

  let url: string;
  if (tail) {
    const params = new URLSearchParams({
      source,
      ...(cookie ? { _pagedResultsCookie: cookie } : {}),
    });
    url = `${tenantBaseUrl}/monitoring/logs/tail?${params}`;
  } else if (transactionId) {
    const params = new URLSearchParams({
      source,
      transactionId,
      ...(cookie ? { _pagedResultsCookie: cookie } : {}),
    });
    url = `${tenantBaseUrl}/monitoring/logs?${params}`;
  } else {
    const params = new URLSearchParams({
      source,
      beginTime: beginTime!,
      ...(endTime ? { endTime } : {}),
      ...(queryFilter ? { _queryFilter: queryFilter } : {}),
      ...(cookie ? { _pagedResultsCookie: cookie } : {}),
    });
    url = `${tenantBaseUrl}/monitoring/logs?${params}`;
  }

  try {
    const res = await fetch(url, {
      headers: authHeaders,
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `HTTP ${res.status}: ${text}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
