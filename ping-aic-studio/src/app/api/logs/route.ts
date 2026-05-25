import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";

/**
 * Build a CREST `_queryFilter` clause that restricts results to entries whose
 * level is in the supplied list. Covers both JSON payloads (`/payload/level`)
 * and plain-text payloads (am-core / idm-core), which prefix the message with
 * the level (e.g. "SEVERE:", "WARNING:", "FINE:"). The text clauses are no-ops
 * against JSON payloads (and vice-versa) so it's safe to OR both forms.
 */
function buildLevelFilter(levels: string[] | undefined): string | undefined {
  if (!levels || levels.length === 0) return undefined;
  const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const jsonClauses = levels.map((l) => `(/payload/level eq "${escape(l)}")`);
  const textClauses = levels.map((l) => `(/payload sw "${escape(l)}:")`);
  return `(${[...jsonClauses, ...textClauses].join(" or ")})`;
}

/** AND-combine two optional `_queryFilter` clauses. */
function combineFilters(a: string | undefined, b: string | undefined): string | undefined {
  if (a && b) return `(${a}) and (${b})`;
  return a ?? b;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { env, source, beginTime, endTime, pageSize = 1000, cookie, tail = false, transactionId, queryFilter, levels } = body as {
    env: string;
    source: string;
    beginTime?: string;
    endTime?: string;
    pageSize?: number;
    cookie?: string;
    tail?: boolean;
    transactionId?: string;
    queryFilter?: string;
    levels?: string[];
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

  // Combine the user-provided query filter with the level filter (if any).
  // Note: `pageSize` was historically destructured but never forwarded — AIC
  // controls page size server-side. Kept for backwards-compatible request
  // shape from the worker.
  const effectiveQueryFilter = combineFilters(queryFilter, buildLevelFilter(levels));

  let url: string;
  if (tail) {
    const params = new URLSearchParams({
      source,
      ...(effectiveQueryFilter ? { _queryFilter: effectiveQueryFilter } : {}),
      ...(cookie ? { _pagedResultsCookie: cookie } : {}),
    });
    url = `${tenantBaseUrl}/monitoring/logs/tail?${params}`;
  } else if (transactionId) {
    const params = new URLSearchParams({
      source,
      transactionId,
      ...(effectiveQueryFilter ? { _queryFilter: effectiveQueryFilter } : {}),
      ...(cookie ? { _pagedResultsCookie: cookie } : {}),
    });
    url = `${tenantBaseUrl}/monitoring/logs?${params}`;
  } else {
    const params = new URLSearchParams({
      source,
      beginTime: beginTime!,
      ...(endTime ? { endTime } : {}),
      ...(effectiveQueryFilter ? { _queryFilter: effectiveQueryFilter } : {}),
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
