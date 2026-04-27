// src/app/api/data/refs/[env]/[type]/[id]/route.ts
//
// Fast dependency lookup using the _refs.json index built at pull time.
// Returns both outgoing refs (this record references) and incoming refs
// (other records that reference this one) without scanning individual files.

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { cwd } from "process";

export const dynamic = "force-dynamic";

export interface RefHit {
    type: string;
    id: string;
}

export interface RefsResponse {
    outgoing: RefHit[];
    incoming: RefHit[];
    /** True when _refs.json is missing (data was pulled before indexing). */
    indexMissing: boolean;
}

type RefsIndex = Record<string, string[]>;

// In-memory cache: key = absolute path to _refs.json, value = { mtime, data }.
const cache = new Map<string, { mtimeMs: number; data: RefsIndex }>();

function loadRefsIndex(refsPath: string): RefsIndex | null {
    if (!fs.existsSync(refsPath)) return null;
    try {
        const stat = fs.statSync(refsPath);
        const cached = cache.get(refsPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
        const data = JSON.parse(fs.readFileSync(refsPath, "utf-8")) as RefsIndex;
        cache.set(refsPath, { mtimeMs: stat.mtimeMs, data });
        return data;
    } catch {
        return null;
    }
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ env: string; type: string; id: string }> },
) {
    const { env, type, id } = await params;
    const managedDir = path.join(cwd(), "environments", env, "managed-data");

    if (!fs.existsSync(managedDir)) {
        return NextResponse.json({ outgoing: [], incoming: [], indexMissing: true } satisfies RefsResponse);
    }

    // ── Outgoing: refs from this record's type index ──────────────────────
    const selfRefsPath = path.join(managedDir, type, "_refs.json");
    const selfIndex = loadRefsIndex(selfRefsPath);
    let indexMissing = selfIndex === null;

    const outgoing: RefHit[] = [];
    if (selfIndex && selfIndex[id]) {
        for (const ref of selfIndex[id]) {
            const m = ref.match(/^managed\/([^/]+)\/(.+)$/);
            if (m) outgoing.push({ type: m[1], id: m[2] });
        }
    }

    // ── Incoming: scan all types' _refs.json for entries pointing here ────
    const needle = `managed/${type}/${id}`;
    const incoming: RefHit[] = [];

    for (const entry of fs.readdirSync(managedDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const refsPath = path.join(managedDir, entry.name, "_refs.json");
        const idx = loadRefsIndex(refsPath);
        if (!idx) {
            if (fs.existsSync(path.join(managedDir, entry.name, "_manifest.json"))) {
                indexMissing = true;
            }
            continue;
        }
        for (const [recordId, refs] of Object.entries(idx)) {
            // Skip self
            if (entry.name === type && recordId === id) continue;
            if (refs.includes(needle)) {
                incoming.push({ type: entry.name, id: recordId });
            }
        }
    }

    return NextResponse.json({ outgoing, incoming, indexMissing } satisfies RefsResponse);
}
