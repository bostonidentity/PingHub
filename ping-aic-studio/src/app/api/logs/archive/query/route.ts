import { NextRequest, NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";
import { queryArchive } from "@/lib/logs/log-query";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(DEFAULT_LOG_SOURCES);

/**
 * Filtered, paginated read over the local log archive.
 * Body: { env, from, to, sources?, eventName?, transactionId?, userId?, level?, text?, offset?, limit? }
 */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    const env = typeof body.env === "string" ? body.env : "";
    const from = typeof body.from === "string" ? body.from : "";
    const to = typeof body.to === "string" ? body.to : "";

    if (!env || !from || !to) {
        return NextResponse.json({ error: "env, from, and to are required." }, { status: 400 });
    }
    if (!getEnvironments().some((e) => e.name === env)) {
        return NextResponse.json({ error: "unknown environment" }, { status: 400 });
    }

    let sources: string[] = Array.isArray(body.sources)
        ? body.sources.filter((s: unknown): s is string => typeof s === "string")
        : [];
    if (sources.length === 0) sources = [...DEFAULT_LOG_SOURCES];
    const invalid = sources.filter((s) => !ALLOWED.has(s));
    if (invalid.length) {
        return NextResponse.json({ error: `unsupported sources: ${invalid.join(", ")}` }, { status: 400 });
    }

    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const numOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

    const result = queryArchive(logDataDir(env), {
        sources,
        from,
        to,
        eventName: str(body.eventName),
        transactionId: str(body.transactionId),
        userId: str(body.userId),
        level: str(body.level),
        text: str(body.text),
        offset: numOr(body.offset, 0),
        limit: numOr(body.limit, 100),
    });

    return NextResponse.json(result);
}
