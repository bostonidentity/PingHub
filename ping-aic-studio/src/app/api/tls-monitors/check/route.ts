import { NextResponse } from "next/server";

import { recordTlsResults } from "@/lib/monitors/history-db";
import { runTlsCheck } from "@/lib/monitors/tls-check";
import { readTlsMonitors } from "@/lib/monitors/tls-persistence";
import type { TlsCheckResult } from "@/lib/monitors/tls-types";

/**
 * POST /api/tls-monitors/check
 * Body: { id?: string }  -- omit id to check all enabled targets.
 * Returns: { results: TlsCheckResult[] }
 */
export async function POST(req: Request) {
    let body: { id?: string } = {};
    try {
        const text = await req.text();
        if (text) body = JSON.parse(text);
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const cfg = readTlsMonitors();
    const targets = body.id
        ? cfg.targets.filter((t) => t.id === body.id)
        : cfg.targets.filter((t) => t.enabled !== false);

    if (body.id && targets.length === 0) {
        return NextResponse.json({ error: `TLS target not found: ${body.id}` }, { status: 404 });
    }

    const results: TlsCheckResult[] = await Promise.all(targets.map((t) => runTlsCheck(t)));
    try {
        recordTlsResults(results);
    } catch (err) {
        console.error("[monitor-history] failed to record TLS results:", err);
    }
    return NextResponse.json({ results });
}
