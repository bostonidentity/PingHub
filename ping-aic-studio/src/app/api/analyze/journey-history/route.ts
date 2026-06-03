import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { analyzeJourneyHistory, type RawAuthEvent } from "@/lib/reports/journey-history";

/**
 * Pull `am-authentication` events for the requested window, paging through
 * AIC's CREST cookie until we exhaust the result set or hit a cap, then run
 * the journey-history analyzer.
 *
 * Body: { env, from, to, treeName?, maxEvents? }
 */

const DEFAULT_MAX_EVENTS = 20000;
const HARD_MAX_EVENTS = 100000;

export async function POST(req: NextRequest) {
    const body = await req.json();
    const {
        env,
        from,
        to,
        treeName,
        maxEvents = DEFAULT_MAX_EVENTS,
    } = body as { env: string; from: string; to: string; treeName?: string; maxEvents?: number };

    if (!env || !from || !to) {
        return NextResponse.json({ error: "env, from, and to are required." }, { status: 400 });
    }
    const cap = Math.min(Math.max(1, Math.floor(maxEvents)), HARD_MAX_EVENTS);

    const creds = getLogApiCredentials(env);
    if (!creds) return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });

    const vars = parseEnvFile(getEnvFileContent(env));
    const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
    if (!tenantBaseUrl) return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });

    const authHeaders = {
        "x-api-key": creds.apiKey,
        "x-api-secret": creds.apiSecret,
    };

    // AIC's /monitoring/logs queryFilter support is finicky — `eq` on
    // /payload/eventName and nested-array paths return empty silently in
    // practice. We narrow with `co` (contains) on the safe-ish substring
    // "AM-TREE" / "AM-NODE-LOGIN-COMPLETED" and re-filter client-side. The
    // `co` clause is best-effort: if AIC ignores it we still get correct
    // results, just with more bytes over the wire.
    const broadFilter =
        '(/payload/eventName co "AM-TREE-LOGIN-") or (/payload/eventName co "AM-NODE-LOGIN-COMPLETED")';

    const allEvents: RawAuthEvent[] = [];
    let cookie: string | undefined;
    let truncated = false;
    let pages = 0;
    let rawFetched = 0;
    const MAX_PAGES = 200; // safety net against pathological loops

    const wantedEventNames = new Set([
        "AM-TREE-LOGIN-INITIATED",
        "AM-TREE-LOGIN-COMPLETED",
        "AM-NODE-LOGIN-COMPLETED",
    ]);
    const treeFilterLc = treeName?.trim().toLowerCase();
    const eventNameCounts = new Map<string, number>();

    // Substring match across both the structured treeName fields the analyzer
    // pulls from, so a partial filter ("MasterLogin") still works.
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

    try {
        while (pages < MAX_PAGES) {
            pages++;
            const params = new URLSearchParams({
                source: "am-authentication",
                beginTime: from,
                endTime: to,
                _queryFilter: broadFilter,
                ...(cookie ? { _pagedResultsCookie: cookie } : {}),
            });
            const url = `${tenantBaseUrl}/monitoring/logs?${params}`;
            const res = await fetch(url, { headers: authHeaders });
            if (!res.ok) {
                const text = await res.text();
                return NextResponse.json({ error: `HTTP ${res.status}: ${text}` }, { status: res.status });
            }
            const data = (await res.json()) as {
                result?: Array<{ timestamp?: string; payload?: unknown }>;
                _pagedResultsCookie?: string | null;
            };
            const page = Array.isArray(data.result) ? data.result : [];
            rawFetched += page.length;
            for (const r of page) {
                if (allEvents.length >= cap) { truncated = true; break; }
                if (!r.timestamp) continue;
                const payload = r.payload ?? {};
                // Client-side narrow to journey events we care about, since
                // server-side queryFilter is best-effort.
                if (typeof payload === "object" && payload !== null) {
                    const evName = (payload as Record<string, unknown>).eventName;
                    if (typeof evName === "string") {
                        eventNameCounts.set(evName, (eventNameCounts.get(evName) ?? 0) + 1);
                    }
                    if (typeof evName !== "string" || !wantedEventNames.has(evName)) continue;
                }
                allEvents.push({
                    timestamp: r.timestamp,
                    payload: payload as RawAuthEvent["payload"],
                });
            }
            if (truncated) break;
            cookie = data._pagedResultsCookie ?? undefined;
            if (!cookie) break;
        }

        // Apply treeName filter at the transactionId level so the analyzer
        // still sees companion events (node visits, inner-journey pairs) for
        // any txn that touches the named tree.
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
        if (truncated || pages >= MAX_PAGES) report.truncated = true;
        const topEventNames = Array.from(eventNameCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([name, count]) => ({ name, count }));
        return NextResponse.json({
            ...report,
            window: { from, to },
            env,
            pagesFetched: pages,
            eventsFetched: analyzed.length,
            rawFetched,
            topEventNames,
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 502 });
    }
}
