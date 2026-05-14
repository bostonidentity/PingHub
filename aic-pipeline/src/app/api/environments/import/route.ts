import { NextRequest, NextResponse } from "next/server";
import { applyBundle, type PerEnvDecision } from "@/lib/env-bundle-io";
import { snapshotEnv, pruneBackups } from "@/lib/env-backup";
import { validateBundle, type BundleV1 } from "@/lib/env-bundle";
import { getEnvironments } from "@/lib/fr-config";
import { appendOpLog } from "@/lib/op-history";

export const dynamic = "force-dynamic";

interface ImportBody {
    bundle?: unknown;
    decisions?: PerEnvDecision[];
    passphrase?: string;
}

export async function POST(req: NextRequest) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let body: ImportBody;
    try {
        body = (await req.json()) as ImportBody;
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (!body.bundle) return NextResponse.json({ error: "bundle is required" }, { status: 400 });
    if (!Array.isArray(body.decisions)) {
        return NextResponse.json({ error: "decisions array is required" }, { status: 400 });
    }
    try {
        validateBundle(body.bundle);
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
        );
    }
    const bundle = body.bundle as BundleV1;
    if (bundle.secretsEncryption === "passphrase-aes-256-gcm" && !body.passphrase) {
        return NextResponse.json(
            { error: "bundle is encrypted — passphrase required" },
            { status: 400 },
        );
    }

    const liveByName = new Map(getEnvironments().map((e) => [e.name, e]));
    const backupPaths = new Map<string, string>();

    let results;
    try {
        results = applyBundle({
            bundle,
            decisions: body.decisions,
            passphrase: body.passphrase,
            beforeOverwrite: (envName) => {
                if (!liveByName.has(envName)) return;
                const p = snapshotEnv(envName);
                backupPaths.set(envName, p);
            },
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
        );
    }

    // Prune old backups for any env we just touched
    for (const envName of backupPaths.keys()) {
        try {
            pruneBackups(envName);
        } catch {
            /* best-effort */
        }
    }

    // Per-env op-log entries so the History view shows each result individually
    for (const r of results) {
        try {
            appendOpLog({
                type: "env-import",
                environment: r.finalName,
                scopes: [r.action],
                status: r.status === "applied" ? "success" : r.status === "failed" ? "failed" : "success",
                startedAt,
                durationMs: Date.now() - t0,
                summary: `${r.action} ${r.bundleName} → ${r.finalName} (${r.status}${r.error ? ": " + r.error : ""})${backupPaths.get(r.finalName) ? `; backup=${backupPaths.get(r.finalName)}` : ""}`,
            });
        } catch {
            /* best-effort */
        }
    }

    const enriched = results.map((r) => ({
        ...r,
        backupPath: backupPaths.get(r.finalName) ?? null,
    }));

    return NextResponse.json({ results: enriched });
}
