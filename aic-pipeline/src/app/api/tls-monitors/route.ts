import { NextResponse } from "next/server";

import { readTlsMonitors, writeTlsMonitors } from "@/lib/monitors/tls-persistence";
import type { TlsGroup, TlsMonitorsFile, TlsTarget } from "@/lib/monitors/tls-types";

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
    const groups: TlsGroup[] = Array.isArray(b.groups) ? (b.groups as TlsGroup[]) : [];
    const groupIds = new Set<string>();
    for (const g of groups) {
        if (!g || typeof g !== "object") return { ok: false, error: "Each group must be an object" };
        if (typeof g.id !== "string" || !g.id) return { ok: false, error: "group.id required" };
        if (typeof g.name !== "string" || !g.name) return { ok: false, error: "group.name required" };
        if (typeof g.order !== "number") return { ok: false, error: "group.order must be a number" };
        if (groupIds.has(g.id)) return { ok: false, error: `Duplicate group id: ${g.id}` };
        groupIds.add(g.id);
    }
    const ids = new Set<string>();
    for (const t of b.targets as TlsTarget[]) {
        if (!t || typeof t !== "object") return { ok: false, error: "Each target must be an object" };
        if (typeof t.id !== "string" || !t.id) return { ok: false, error: "target.id required" };
        if (typeof t.label !== "string" || !t.label) return { ok: false, error: "target.label required" };
        if (typeof t.url !== "string" || !t.url) return { ok: false, error: "target.url required" };
        if (ids.has(t.id)) return { ok: false, error: `Duplicate target id: ${t.id}` };
        ids.add(t.id);
    }
    return { ok: true, data: { groups, targets: b.targets as TlsTarget[] } };
}
