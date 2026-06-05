import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent, getEnvironments } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { analyzeJourneyHistory, type RawAuthEvent } from "@/lib/reports/journey-history";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { readRange } from "@/lib/logs/log-archive-store";
import { readManifest, rangeCoverage } from "@/lib/logs/manifest";

/**
 * Produce a journey-history report for the requested window. Two sources:
 *   - "live" (default): page `am-authentication` from AIC's /monitoring/logs.
 *   - "archive": read `am-authentication` from the local log archive — offline,
 *     instant, never truncated. Requires a prior pull (Phase A2).
 *
 * Body: { env, from, to, treeName?, maxEvents?, source? }
 * Streams NDJSON: progress* then a final `done` (or `error`).
 */

const DEFAULT_MAX_EVENTS = 20000;
const HARD_MAX_EVENTS = 100000;
const JOURNEY_SOURCE = "am-authentication";

export async function POST(req: NextRequest) {
    const body = await req.json();
    const {
        env,
        from,
        to,
        treeName,
        maxEvents = DEFAULT_MAX_EVENTS,
    } = body as { env: string; from: string; to: string; treeName?: string; maxEvents?: number; source?: string };
    const source = body.source === "archive" ? "archive" : "live";

    if (!env || !from || !to) {
        return NextResponse.json({ error: "env, from, and to are required." }, { status: 400 });
    }
    // Allowlist env against real environments before any file-path construction.
    if (!getEnvironments().some((e) => e.name === env)) {
        return NextResponse.json({ error: "unknown environment" }, { status: 400 });
    }
    const cap = Math.min(Math.max(1, Math.floor(maxEvents)), HARD_MAX_EVENTS);

    // Live mode needs Log-API credentials + tenant URL; archive mode reads disk.
    let tenantBaseUrl = "";
    let authHeaders: Record<string, string> = {};
    if (source === "live") {
        const creds = getLogApiCredentials(env);
        if (!creds) return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });
        const vars = parseEnvFile(getEnvFileContent(env));
        tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "") ?? "";
        if (!tenantBaseUrl) return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });
        authHeaders = { "x-api-key": creds.apiKey, "x-api-secret": creds.apiSecret };
    }

    // AIC's /monitoring/logs queryFilter support is finicky — `eq` on
    // /payload/eventName and nested-array paths return empty silently in
    // practice. We narrow with `co` (contains) and re-filter client-side.
    const broadFilter =
        '(/payload/eventName co "AM-TREE-LOGIN-") or (/payload/eventName co "AM-NODE-LOGIN-COMPLETED")';

    const allEvents: RawAuthEvent[] = [];
    let cookie: string | undefined;
    let truncated = false;
    let pages = 0;
    let rawFetched = 0;
    let coverage: "full" | "partial" | "none" | undefined;
    const MAX_PAGES = 200; // safety net against pathological loops

    const wantedEventNames = new Set([
        "AM-TREE-LOGIN-INITIATED",
        "AM-TREE-LOGIN-COMPLETED",
        "AM-NODE-LOGIN-COMPLETED",
    ]);
    const treeFilterLc = treeName?.trim().toLowerCase();
    const eventNameCounts = new Map<string, number>();

    // Substring match across both treeName fields the analyzer pulls from.
    function matchesTreeName(payload: unknown): boolean {
        if (!treeFilterLc) return true;
        if (typeof payload !== "object" || payload === null) return false;
        const p = payload as Record<string, unknown>;
        const direct = typeof p.treeName === "string" ? p.treeName.toLowerCase() : "";
        if (direct.includes(treeFilterLc)) return true;
        const entries = p.entries;
        if (Array.isArray(entries) && entries.length > 0) {
            const info = (entries[0] as Record<string, unknown>)?.info;
            const t = info && typeof info === "object" && typeof (info as Record<string, unknown>).treeName === "string"
                ? ((info as Record<string, unknown>).treeName as string).toLowerCase() : "";
            if (t.includes(treeFilterLc)) return true;
        }
        return false;
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (msg: unknown) => controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
            const startedAt = Date.now();
            try {
                if (source === "archive") {
                    // Read the window straight from local NDJSON. No paging, no cap
                    // on bytes over the wire; we still honor `cap` defensively.
                    const archiveRoot = logDataDir(env);
                    const manifest = readManifest(archiveRoot);
                    coverage = rangeCoverage(manifest.sources[JOURNEY_SOURCE]?.coveredRanges ?? [], from, to);
                    const entries = readRange(archiveRoot, JOURNEY_SOURCE, from, to);
                    rawFetched = entries.length;
                    for (const e of entries) {
                        if (allEvents.length >= cap) { truncated = true; break; }
                        const payload = e.payload ?? {};
                        const evName = (payload as Record<string, unknown>).eventName;
                        if (typeof evName === "string") {
                            eventNameCounts.set(evName, (eventNameCounts.get(evName) ?? 0) + 1);
                        }
                        if (typeof evName !== "string" || !wantedEventNames.has(evName)) continue;
                        allEvents.push({ timestamp: e.timestamp, payload: payload as RawAuthEvent["payload"] });
                    }
                    send({ type: "progress", page: 1, rawFetched, matched: allEvents.length, truncated });
                } else {
                    while (pages < MAX_PAGES) {
                        pages++;
                        const params = new URLSearchParams({
                            source: JOURNEY_SOURCE,
                            beginTime: from,
                            endTime: to,
                            _queryFilter: broadFilter,
                            ...(cookie ? { _pagedResultsCookie: cookie } : {}),
                        });
                        const url = `${tenantBaseUrl}/monitoring/logs?${params}`;
                        const res = await fetch(url, { headers: authHeaders });
                        if (!res.ok) {
                            const text = await res.text();
                            send({ type: "error", error: `HTTP ${res.status}: ${text}` });
                            controller.close();
                            return;
                        }
                        const data = (await res.json()) as {
                            result?: Array<{ timestamp?: string; payload?: unknown }>;
                            // CREST asymmetry: request param is `_pagedResultsCookie`,
                            // RESPONSE field is `pagedResultsCookie` (no underscore).
                            pagedResultsCookie?: string | null;
                        };
                        const page = Array.isArray(data.result) ? data.result : [];
                        rawFetched += page.length;
                        for (const r of page) {
                            if (allEvents.length >= cap) { truncated = true; break; }
                            if (!r.timestamp) continue;
                            const payload = r.payload ?? {};
                            if (typeof payload === "object" && payload !== null) {
                                const evName = (payload as Record<string, unknown>).eventName;
                                if (typeof evName === "string") {
                                    eventNameCounts.set(evName, (eventNameCounts.get(evName) ?? 0) + 1);
                                }
                                if (typeof evName !== "string" || !wantedEventNames.has(evName)) continue;
                            }
                            allEvents.push({ timestamp: r.timestamp, payload: payload as RawAuthEvent["payload"] });
                        }
                        send({ type: "progress", page: pages, rawFetched, matched: allEvents.length, truncated });
                        if (truncated) break;
                        cookie = data.pagedResultsCookie ?? undefined;
                        if (!cookie) break;
                    }
                }

                // Apply treeName filter at the transactionId level so the analyzer
                // still sees companion events for any txn that touches the tree.
                let analyzed = allEvents;
                if (treeFilterLc) {
                    const keepTxns = new Set<string>();
                    for (const e of allEvents) {
                        if (!matchesTreeName(e.payload)) continue;
                        if (typeof e.payload === "object" && e.payload !== null) {
                            const t = (e.payload as Record<string, unknown>).transactionId;
                            if (typeof t === "string") keepTxns.add(t);
                        }
                    }
                    analyzed = allEvents.filter((e) => {
                        if (typeof e.payload !== "object" || e.payload === null) return false;
                        const t = (e.payload as Record<string, unknown>).transactionId;
                        return typeof t === "string" && keepTxns.has(t);
                    });
                }

                const report = analyzeJourneyHistory(analyzed);
                if (truncated || (source === "live" && pages >= MAX_PAGES)) report.truncated = true;
                const topEventNames = Array.from(eventNameCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 20)
                    .map(([name, count]) => ({ name, count }));
                send({
                    type: "done",
                    ...report,
                    window: { from, to },
                    env,
                    source,
                    coverage,
                    pagesFetched: pages,
                    eventsFetched: analyzed.length,
                    rawFetched,
                    topEventNames,
                    durationMs: Math.max(0, Date.now() - startedAt),
                });
                controller.close();
            } catch (err) {
                try {
                    send({ type: "error", error: String(err) });
                    controller.close();
                } catch {
                    // Stream already closed / client disconnected — nothing to do.
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
        },
    });
}
