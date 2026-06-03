import v8 from "node:v8";
import { appendEntries } from "./log-archive-store";
import { readManifest, writeManifest, addCoveredRange } from "./manifest";
import { fetchLogPage, paceDelayMs } from "./log-fetch";
import type { LogPullJob } from "./log-job-types";
import type { LogRegistry } from "./log-job-registry";
import type { RawLogEntry } from "./log-types";

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_HEAP_SUSPEND_FRACTION = 0.7;

function heapUnderPressure(fraction: number): boolean {
    const { heap_size_limit, used_heap_size } = v8.getHeapStatistics();
    if (!heap_size_limit) return false;
    return used_heap_size / heap_size_limit >= fraction;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RunLogPullOpts {
    job: LogPullJob;
    registry: LogRegistry;
    /** `ENVIRONMENTS_DIR/{env}/log-data`. */
    archiveRoot: string;
    tenantBaseUrl: string;
    apiKey: string;
    apiSecret: string;
    signal: AbortSignal;
    fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
    /** Current epoch ms — injected for deterministic pacing in tests. */
    nowMs?: () => number;
    pageSize?: number;
}

/**
 * Pull each source's logs for the job's [from,to] window into the archive.
 *
 * Per source: page AIC `/monitoring/logs` (cursor = `pagedResultsCookie`),
 * store each page via `appendEntries` (dedup by `payload._id`), pace under the
 * rate limit, and on full exhaustion fold [from,to] into the manifest's covered
 * ranges. Resumes from a source's saved cookie; dedup makes re-pulled pages
 * harmless. Self-suspends under heap pressure (cookie persisted for resume).
 */
export async function runLogPull(opts: RunLogPullOpts): Promise<void> {
    const {
        job, registry, archiveRoot, tenantBaseUrl, apiKey, apiSecret, signal,
        fetchFn = fetch,
        sleepFn = defaultSleep,
        nowMs = () => Date.now(),
        pageSize = DEFAULT_PAGE_SIZE,
    } = opts;

    const base = tenantBaseUrl.replace(/\/+$/, "");
    const headers = { "x-api-key": apiKey, "x-api-secret": apiSecret };

    if (signal.aborted) {
        registry.setJobStatus(job.id, "aborted");
        return;
    }
    registry.setJobStatus(job.id, "running");

    for (const source of job.sources) {
        if (signal.aborted) break;
        const progress = job.progress.find((p) => p.source === source);
        if (progress?.status === "done") continue;

        registry.updateProgress(job.id, source, { status: "running" });

        let cookie: string | null = progress?.cookie ?? null;
        let fetched = progress?.fetched ?? 0;
        let stored = progress?.stored ?? 0;
        let storedThisRun = 0;
        let sourceFailed = false;
        let suspended = false;

        for (;;) {
            if (signal.aborted) break;

            const params = new URLSearchParams({
                source,
                beginTime: job.from,
                endTime: job.to,
                _pageSize: String(pageSize),
            });
            if (cookie) params.set("_pagedResultsCookie", cookie);
            const url = `${base}/monitoring/logs?${params}`;

            const res = await fetchLogPage(url, headers, { fetchFn, signal, sleepFn });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                registry.updateProgress(job.id, source, {
                    status: "failed",
                    error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
                });
                sourceFailed = true;
                break;
            }

            const data = (await res.json()) as { result?: RawLogEntry[]; pagedResultsCookie?: string | null };
            const entries = Array.isArray(data.result) ? data.result : [];
            const appended = appendEntries(archiveRoot, source, entries);
            fetched += entries.length;
            stored += appended.inserted;
            storedThisRun += appended.inserted;
            cookie = data.pagedResultsCookie ?? null;
            registry.updateProgress(job.id, source, { fetched, stored, cookie });

            if (!cookie) break; // source exhausted

            // Pace to stay under the rate limit, then check heap pressure.
            const wait = paceDelayMs(res, nowMs());
            if (wait > 0) await sleepFn(wait);
            if (heapUnderPressure(DEFAULT_HEAP_SUSPEND_FRACTION)) {
                registry.setJobStatus(job.id, "suspending");
                suspended = true;
                break;
            }
        }

        if (suspended) return; // leave cookie persisted; a resume continues
        if (signal.aborted) break;

        if (!sourceFailed && cookie === null) {
            // Source fully covered for [from,to]: fold the range into the manifest.
            const manifest = readManifest(archiveRoot);
            const updated = addCoveredRange(manifest, source, { from: job.from, to: job.to });
            const sm = updated.sources[source];
            sm.entryCount = (sm.entryCount ?? 0) + storedThisRun;
            writeManifest(archiveRoot, updated);
            registry.updateProgress(job.id, source, { status: "done" });
        }
    }

    if (signal.aborted) {
        registry.setJobStatus(job.id, "aborted");
        return;
    }
    registry.setJobStatus(job.id, "completed");
}
