import { NextRequest, NextResponse } from "next/server";
import { isAlreadyProbing, markProbeDone, markProbing, refreshOne } from "@/lib/health/auto-refresh";

export async function POST(req: NextRequest) {
    const { env } = (await req.json().catch(() => ({}))) as { env?: string };
    if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });
    if (isAlreadyProbing(env)) {
        return NextResponse.json({ status: "in-flight" }, { status: 202 });
    }
    if (!markProbing(env)) {
        return NextResponse.json({ status: "in-flight" }, { status: 202 });
    }
    try {
        const entry = await refreshOne(env);
        return NextResponse.json(entry);
    } finally {
        markProbeDone(env);
    }
}
