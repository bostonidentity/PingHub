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

/** Abort-aware sleep: resolves immediately if the signal is/becomes aborted. */
const defaultSleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        const id = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
    });

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
    sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
 *
 * Robustness: a per-source try/catch guarantees the job always reaches a
 * terminal status — a thrown page (malformed JSON, fs error) marks that source
 * failed rather than escaping and leaving the job stuck "running" (which would
 * block all future pulls for the env via the registry conflict guard).
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
        let sourceFailed = false;
        let suspended = false;

        try {
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
                cookie = data.pagedResultsCookie ?? null;
                registry.updateProgress(job.id, source, { fetched, stored, cookie });

                if (!cookie) break; // source exhausted

                // Pace to stay under the rate limit, then check heap pressure.
                const wait = paceDelayMs(res, nowMs());
                if (wait > 0) await sleepFn(wait, signal);
                if (heapUnderPressure(DEFAULT_HEAP_SUSPEND_FRACTION)) {
                    registry.setJobStatus(job.id, "suspending");
                    suspended = true;
                    break;
                }
            }
        } catch (err) {
            // A thrown page (malformed JSON, fs/ENOSPC, network) must not escape
            // and leave the job stuck "running". Record the source failed; the
            // final setJobStatus below still reaches a terminal state.
            if (!signal.aborted) {
                registry.updateProgress(job.id, source, {
                    status: "failed",
                    error: (err as Error).message,
                });
                sourceFailed = true;
            }
        }

        if (suspended) return; // leave cookie persisted; a resume continues
        if (signal.aborted) break;

        if (!sourceFailed && cookie === null) {
            // Source fully covered for [from,to]: fold the range into the manifest.
            // This read-modify-write is safe because the registry allows only one
            // active job per env (LogJobConflictError), so there is no concurrent
            // manifest writer.
            const manifest = readManifest(archiveRoot);
            const updated = addCoveredRange(manifest, source, { from: job.from, to: job.to });
            const sm = updated.sources[source];
            // `stored` is cumulative new inserts across all (resumed) runs of this
            // source; entryCount is only written here on full exhaustion, so adding
            // `stored` counts every session, not just the final one.
            sm.entryCount = (sm.entryCount ?? 0) + stored;
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
