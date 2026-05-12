import { NextResponse } from "next/server";

import { readMonitors, writeMonitors } from "@/lib/monitors/persistence";
import type { MonitorsFile } from "@/lib/monitors/types";

export async function GET() {
    return NextResponse.json(readMonitors());
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
    writeMonitors(validation.data);
    return NextResponse.json(validation.data);
}

function validate(body: unknown):
    | { ok: true; data: MonitorsFile }
    | { ok: false; error: string } {
    if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object" };
    const b = body as Partial<MonitorsFile>;
    if (!Array.isArray(b.groups)) return { ok: false, error: "groups must be an array" };
    if (!Array.isArray(b.monitors)) return { ok: false, error: "monitors must be an array" };
    const groupIds = new Set<string>();
    for (const g of b.groups) {
        if (!g || typeof g !== "object") return { ok: false, error: "Each group must be an object" };
        if (typeof g.id !== "string" || !g.id) return { ok: false, error: "group.id required" };
        if (typeof g.name !== "string" || !g.name) return { ok: false, error: "group.name required" };
        if (typeof g.order !== "number") return { ok: false, error: "group.order required" };
        if (groupIds.has(g.id)) return { ok: false, error: `Duplicate group id: ${g.id}` };
        groupIds.add(g.id);
    }
    const monIds = new Set<string>();
    for (const m of b.monitors) {
        if (!m || typeof m !== "object") return { ok: false, error: "Each monitor must be an object" };
        if (typeof m.id !== "string" || !m.id) return { ok: false, error: "monitor.id required" };
        if (typeof m.url !== "string" || !m.url) return { ok: false, error: "monitor.url required" };
        if (typeof m.label !== "string" || !m.label) return { ok: false, error: "monitor.label required" };
        if (typeof m.groupId !== "string" || !groupIds.has(m.groupId)) {
            return { ok: false, error: `monitor.groupId invalid for ${m.label}` };
        }
        if (monIds.has(m.id)) return { ok: false, error: `Duplicate monitor id: ${m.id}` };
        monIds.add(m.id);
    }
    return { ok: true, data: { groups: b.groups, monitors: b.monitors } };
}
