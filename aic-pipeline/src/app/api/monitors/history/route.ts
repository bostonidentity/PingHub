import { NextResponse } from "next/server";

import {
    getServerAvailability,
    getServerHistory,
    getTlsHistory,
} from "@/lib/monitors/history-db";

/**
 * GET /api/monitors/history?kind=server|tls&targetId=...&hours=24&bucket=1m
 *
 * Defaults: hours=24, bucket=auto (choose so we end up with ~120 buckets).
 * Set bucket=0 for raw points.
 *
 * Response:
 *   { kind, targetId, from, to, bucketMs, points: [...], availability? }
 */

function parseBucket(spec: string | null, rangeMs: number): number {
    if (spec === null || spec === "auto") {
        // Aim for ~120 buckets across the range, snapped to common sizes.
        const ideal = rangeMs / 120;
        const ladder = [
            10_000, // 10s
            30_000, // 30s
            60_000, // 1m
            5 * 60_000, // 5m
            10 * 60_000, // 10m
            15 * 60_000, // 15m
            30 * 60_000, // 30m
            60 * 60_000, // 1h
            6 * 60 * 60_000, // 6h
            24 * 60 * 60_000, // 1d
        ];
        for (const step of ladder) {
            if (ideal <= step) return step;
        }
        return ladder[ladder.length - 1];
    }
    const m = spec.match(/^(\d+)\s*(s|m|h|d)?$/i);
    if (m) {
        const n = Number(m[1]);
        const unit = (m[2] ?? "s").toLowerCase();
        const mult =
            unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
        return n * mult;
    }
    const n = Number(spec);
    return Number.isFinite(n) ? n : 60_000;
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const kind = (url.searchParams.get("kind") ?? "server").toLowerCase();
    const targetId = url.searchParams.get("targetId");
    if (!targetId) {
        return NextResponse.json({ error: "Missing 'targetId' query param" }, { status: 400 });
    }

    const hours = Number(url.searchParams.get("hours") ?? "24");
    const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : 24;
    const to = Date.now();
    const from = to - safeHours * 3_600_000;
    const bucketMs = parseBucket(url.searchParams.get("bucket"), to - from);

    try {
        if (kind === "tls") {
            const points = getTlsHistory(targetId, from, to, bucketMs);
            return NextResponse.json({
                kind: "tls",
                targetId,
                from,
                to,
                bucketMs,
                points,
            });
        }
        const points = getServerHistory(targetId, from, to, bucketMs);
        const availability = getServerAvailability(targetId, from, to);
        return NextResponse.json({
            kind: "server",
            targetId,
            from,
            to,
            bucketMs,
            points,
            availability,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
