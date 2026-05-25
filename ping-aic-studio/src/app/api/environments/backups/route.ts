import { NextRequest, NextResponse } from "next/server";
import { listBackups, deleteBackup, readBackup, pruneBackups } from "@/lib/env-backup";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const envName = url.searchParams.get("name") ?? undefined;
    const file = url.searchParams.get("file");
    if (file) {
        try {
            const bundle = readBackup(file);
            if (!bundle) return NextResponse.json({ error: "not found" }, { status: 404 });
            return NextResponse.json(bundle);
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 400 },
            );
        }
    }
    return NextResponse.json({ backups: listBackups(envName) });
}

export async function DELETE(req: NextRequest) {
    const url = new URL(req.url);
    const file = url.searchParams.get("file");
    const prune = url.searchParams.get("prune");
    if (prune) {
        const deleted = pruneBackups(prune);
        return NextResponse.json({ deleted });
    }
    if (!file) return NextResponse.json({ error: "file or prune query param required" }, { status: 400 });
    const ok = deleteBackup(file);
    if (!ok) return NextResponse.json({ error: "not found or invalid name" }, { status: 404 });
    return NextResponse.json({ ok: true });
}
