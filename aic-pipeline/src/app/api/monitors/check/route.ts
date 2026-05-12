import { NextResponse } from "next/server";

import { runMonitorCheck } from "@/lib/monitors/check";
import { readMonitors } from "@/lib/monitors/persistence";
import type { MonitorCheckResult } from "@/lib/monitors/types";

/**
 * POST /api/monitors/check
 * Body: { id?: string }  -- omit id to check all enabled monitors.
 * Returns: { results: MonitorCheckResult[] }
 */
export async function POST(req: Request) {
    let body: { id?: string } = {};
    try {
        const text = await req.text();
        if (text) body = JSON.parse(text);
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const cfg = readMonitors();
    const targets = body.id
        ? cfg.monitors.filter((m) => m.id === body.id)
        : cfg.monitors.filter((m) => m.enabled !== false);

    if (body.id && targets.length === 0) {
        return NextResponse.json({ error: `Monitor not found: ${body.id}` }, { status: 404 });
    }

    const results: MonitorCheckResult[] = await Promise.all(
        targets.map((t) => runMonitorCheck(t)),
    );
    return NextResponse.json({ results });
}
