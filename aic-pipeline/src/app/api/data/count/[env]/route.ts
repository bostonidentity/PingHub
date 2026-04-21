// src/app/api/data/count/[env]/route.ts
import { NextRequest } from "next/server";
import path from "path";
import fs from "fs";
import { cwd } from "process";
import { parseEnvFile } from "@/lib/env-parser";
import { getAccessToken } from "@/lib/iga-api";

export const dynamic = "force-dynamic";

/**
 * NDJSON streaming endpoint. One JSON object per line:
 *   {"event":"start","type":"alpha_user"}
 *   {"event":"progress","type":"alpha_user","fetched":1000,"pages":1}
 *   {"event":"done","type":"alpha_user","count":8214}
 *   {"event":"done","type":"alpha_role","count":null,"reason":"…"}
 *   {"event":"fatal","error":"Token error: …"}   ← ends stream
 *   {"event":"end"}                              ← normal completion
 */
export type ProbeEvent =
  | { event: "start"; type: string }
  | { event: "progress"; type: string; fetched: number; pages: number }
  | { event: "done"; type: string; count: number | null; reason?: string }
  | { event: "fatal"; error: string }
  | { event: "end" };

const MAX_TYPES = 80;
const ID_PAGE_SIZE = 1000;
const PAGINATION_COUNT_CAP = 200_000;

function envVarsFor(env: string): Record<string, string> | null {
  const envFile = path.join(cwd(), "environments", env, ".env");
  if (!fs.existsSync(envFile)) return null;
  return parseEnvFile(fs.readFileSync(envFile, "utf-8")) as Record<string, string>;
}

type ProbeResult = { count: number } | { count: null; reason: string };

async function probePolicy(
  tenantUrl: string,
  type: string,
  token: string,
  policy: "EXACT" | "ESTIMATE",
): Promise<ProbeResult> {
  const url = new URL(`${tenantUrl}/openidm/managed/${type}`);
  url.searchParams.set("_queryFilter", "true");
  url.searchParams.set("_countPolicy", policy);
  url.searchParams.set("_pageSize", "1");
  try {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const snippet = body.slice(0, 120).replace(/\s+/g, " ").trim();
      return { count: null, reason: `${policy} → HTTP ${res.status}${snippet ? `: ${snippet}` : ""}` };
    }
    const data = await res.json() as { totalPagedResults?: number };
    if (typeof data.totalPagedResults !== "number") {
      return { count: null, reason: `${policy} → response had no totalPagedResults` };
    }
    if (data.totalPagedResults < 0) {
      return { count: null, reason: `${policy} → totalPagedResults=${data.totalPagedResults}` };
    }
    return { count: data.totalPagedResults };
  } catch (e) {
    return { count: null, reason: `${policy} → ${(e as Error).message}` };
  }
}

async function probeType(
  tenantUrl: string,
  type: string,
  token: string,
  emit: (ev: ProbeEvent) => void,
): Promise<ProbeResult> {
  const exact = await probePolicy(tenantUrl, type, token, "EXACT");
  if (exact.count !== null) return exact;
  const estimate = await probePolicy(tenantUrl, type, token, "ESTIMATE");
  if (estimate.count !== null) return estimate;

  // Paginated ID-only count fallback. Progress events fire after each page.
  let cookie: string | null = null;
  let total = 0;
  let pages = 0;
  while (true) {
    const url = new URL(`${tenantUrl}/openidm/managed/${type}`);
    url.searchParams.set("_queryFilter", "true");
    url.searchParams.set("_fields", "_id");
    url.searchParams.set("_pageSize", String(ID_PAGE_SIZE));
    if (cookie) url.searchParams.set("_pagedResultsCookie", cookie);
    try {
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const snippet = body.slice(0, 120).replace(/\s+/g, " ").trim();
        return { count: null, reason: `${exact.reason}; ${estimate.reason}; pagination → HTTP ${res.status}${snippet ? `: ${snippet}` : ""}` };
      }
      const data = await res.json() as { result?: unknown[]; pagedResultsCookie?: string | null };
      const n = Array.isArray(data.result) ? data.result.length : 0;
      total += n;
      pages++;
      emit({ event: "progress", type, fetched: total, pages });
      cookie = data.pagedResultsCookie ?? null;
      if (!cookie) break;
      if (total >= PAGINATION_COUNT_CAP) {
        return { count: null, reason: `${exact.reason}; ${estimate.reason}; pagination → >${PAGINATION_COUNT_CAP.toLocaleString()} (capped after ${pages} pages)` };
      }
    } catch (e) {
      return { count: null, reason: `${exact.reason}; ${estimate.reason}; pagination → ${(e as Error).message}` };
    }
  }
  return { count: total };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  const body = await req.json().catch(() => ({}));
  const typesRaw = Array.isArray(body.types)
    ? body.types.filter((t: unknown) => typeof t === "string").slice(0, MAX_TYPES)
    : [];
  const types: string[] = typesRaw;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (ev: ProbeEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      };

      if (types.length === 0) {
        emit({ event: "end" });
        controller.close();
        return;
      }

      const envVars = envVarsFor(env);
      if (!envVars) {
        emit({ event: "fatal", error: "env not found" });
        controller.close();
        return;
      }

      let token: string;
      try {
        token = await getAccessToken(envVars);
      } catch (e) {
        emit({ event: "fatal", error: (e as Error).message });
        controller.close();
        return;
      }

      const tenantUrl = envVars.TENANT_BASE_URL ?? "";

      // Sequential so the UI can highlight one type at a time. Probing types
      // one after another also avoids hammering the tenant with concurrent
      // count queries.
      for (const type of types) {
        emit({ event: "start", type });
        const r = await probeType(tenantUrl, type, token, emit);
        emit({ event: "done", type, count: r.count, reason: r.count === null ? (r as { reason: string }).reason : undefined });
      }

      emit({ event: "end" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}
