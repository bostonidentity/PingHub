import { NextResponse } from "next/server";

import { readTlsMonitors, writeTlsMonitors } from "@/lib/monitors/tls-persistence";
import type { TlsMonitorsFile, TlsTarget } from "@/lib/monitors/tls-types";

export async function GET() {
    return NextResponse.json(readTlsMonitors());
}

export async function PUT(req: Request) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const validation = validate(body);
    if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    writeTlsMonitors(validation.data);
    return NextResponse.json(validation.data);
}

function validate(body: unknown):
    | { ok: true; data: TlsMonitorsFile }
    | { ok: false; error: string } {
    if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object" };
    const b = body as Partial<TlsMonitorsFile>;
    if (!Array.isArray(b.targets)) return { ok: false, error: "targets must be an array" };
    const ids = new Set<string>();
    for (const t of b.targets as TlsTarget[]) {
        if (!t || typeof t !== "object") return { ok: false, error: "Each target must be an object" };
        if (typeof t.id !== "string" || !t.id) return { ok: false, error: "target.id required" };
        if (typeof t.label !== "string" || !t.label) return { ok: false, error: "target.label required" };
        if (typeof t.url !== "string" || !t.url) return { ok: false, error: "target.url required" };
        if (ids.has(t.id)) return { ok: false, error: `Duplicate target id: ${t.id}` };
        ids.add(t.id);
    }
    return { ok: true, data: { targets: b.targets as TlsTarget[] } };
}
