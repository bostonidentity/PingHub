import { NextRequest, NextResponse } from "next/server";
import { getLogApiCredentials, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { getLogRegistry, LogJobConflictError } from "@/lib/logs/log-job-registry";
import { runLogPull } from "@/lib/logs/log-pull-runner";
import { setController, deleteController } from "../route-controllers";

export const dynamic = "force-dynamic";

/** The log sources the archive supports (AM + IDM). */
export const DEFAULT_LOG_SOURCES = [
    "am-authentication", "am-access", "am-core",
    "idm-access", "idm-activity", "idm-authentication",
];
const ALLOWED = new Set(DEFAULT_LOG_SOURCES);

/**
 * Body: { env, from, to, sources? }. `from`/`to` are ISO timestamps. When
 * `sources` is omitted, all supported sources are pulled. Starts a background
 * pull and returns 202 with the job id; the client polls GET /jobs for progress.
 */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    const env = typeof body.env === "string" ? body.env : "";
    const from = typeof body.from === "string" ? body.from : "";
    const to = typeof body.to === "string" ? body.to : "";
    let sources: string[] = Array.isArray(body.sources)
        ? body.sources.filter((s: unknown): s is string => typeof s === "string")
        : [];
    if (sources.length === 0) sources = [...DEFAULT_LOG_SOURCES];

    if (!env || !from || !to) {
        return NextResponse.json({ error: "env, from, and to are required" }, { status: 400 });
    }
    const invalid = sources.filter((s) => !ALLOWED.has(s));
    if (invalid.length) {
        return NextResponse.json({ error: `unsupported sources: ${invalid.join(", ")}` }, { status: 400 });
    }

    const creds = getLogApiCredentials(env);
    if (!creds) {
        return NextResponse.json({ error: "No Log API credentials configured for this environment." }, { status: 400 });
    }
    const vars = parseEnvFile(getEnvFileContent(env));
    const tenantBaseUrl = vars.TENANT_BASE_URL?.replace(/\/+$/, "");
    if (!tenantBaseUrl) {
        return NextResponse.json({ error: "No TENANT_BASE_URL in environment config." }, { status: 400 });
    }

    const registry = getLogRegistry();
    let job;
    try {
        job = registry.startJob(env, sources, from, to);
    } catch (e) {
        // instanceof can fail when the singleton survives a module reload; also
        // match by name.
        if (e instanceof LogJobConflictError || (e as Error).name === "LogJobConflictError") {
            const existingId = (e as LogJobConflictError).existingJobId;
            const existing = registry.getJob(existingId);
            return NextResponse.json({ jobId: existingId, status: existing?.status ?? "running" }, { status: 409 });
        }
        throw e;
    }

    const ctl = new AbortController();
    setController(job.id, ctl);
    void runLogPull({
        job,
        registry,
        archiveRoot: logDataDir(env),
        tenantBaseUrl,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        signal: ctl.signal,
    }).finally(() => deleteController(job.id));

    return NextResponse.json({ jobId: job.id, sources }, { status: 202 });
}
