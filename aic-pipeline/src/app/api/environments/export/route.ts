import { NextRequest, NextResponse } from "next/server";
import os from "node:os";
import { buildBundle } from "@/lib/env-bundle-io";
import { bundleSha256, type SecretsMode } from "@/lib/env-bundle";
import { appendOpLog } from "@/lib/op-history";
import pkg from "../../../../../package.json";

export const dynamic = "force-dynamic";

interface ExportBody {
    names?: string[];
    secretsMode?: SecretsMode;
    passphrase?: string;
}

export async function POST(req: NextRequest) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let body: ExportBody;
    try {
        body = (await req.json()) as ExportBody;
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === "string") : [];
    const secretsMode: SecretsMode = body.secretsMode ?? "exclude";
    if (!names.length) return NextResponse.json({ error: "names is required" }, { status: 400 });
    if (!["exclude", "plain", "encrypted"].includes(secretsMode)) {
        return NextResponse.json({ error: "invalid secretsMode" }, { status: 400 });
    }
    if (secretsMode === "encrypted" && (!body.passphrase || body.passphrase.length < 12)) {
        return NextResponse.json(
            { error: "passphrase of at least 12 characters required for encrypted mode" },
            { status: 400 },
        );
    }

    let bundle, totalSecrets;
    try {
        const result = buildBundle({
            names,
            secretsMode,
            passphrase: body.passphrase,
            exportedBy: os.userInfo().username,
            appVersion: (pkg as { version?: string }).version,
        });
        bundle = result.bundle;
        totalSecrets = result.totalSecrets;
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
        );
    }

    const json = JSON.stringify(bundle, null, 2);
    const sha256 = bundleSha256(bundle);

    const ts = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..+/, "")
        .replace("T", "-");
    const host = os.hostname().replace(/[^a-zA-Z0-9-]/g, "");
    const suffix = secretsMode === "plain" ? "-secrets" : secretsMode === "encrypted" ? "-encrypted" : "";
    const filename = `pinghub-envs-${host}-${ts}${suffix}.json`;

    try {
        appendOpLog({
            type: "env-export",
            environment: names.join(","),
            scopes: [secretsMode],
            status: "success",
            startedAt,
            durationMs: Date.now() - t0,
            summary: `exported ${names.length} env(s), secrets=${secretsMode}, redacted=${totalSecrets}, sha256=${sha256.slice(0, 12)}`,
        });
    } catch {
        /* logging is best-effort */
    }

    return new NextResponse(json, {
        status: 200,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "X-PingHub-Bundle-Sha256": sha256,
        },
    });
}
