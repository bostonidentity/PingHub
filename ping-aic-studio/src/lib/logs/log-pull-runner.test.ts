import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { runLogPull } from "./log-pull-runner";
import { createLogRegistry } from "./log-job-registry";
import { readManifest } from "./manifest";
import { readRange } from "./log-archive-store";

function tmpEnvsRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-run-"));
}

const FROM = "2026-06-02T00:00:00Z";
const TO = "2026-06-03T00:00:00Z";

/** Minimal Response stub. */
function jsonRes(body: unknown, headers: Record<string, string> = {}): Response {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
        status: 200,
        ok: true,
        headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function logEntry(id: string, ts: string) {
    return {
        timestamp: ts,
        source: "am-authentication",
        payload: { _id: id, transactionId: "txn-1", eventName: "AM-TREE-LOGIN-COMPLETED", level: "INFO", realm: "/alpha", principal: "alice" },
    };
}

/** A fetch mock that pages: page 1 returns a cookie, page 2 (with cookie) ends. */
function pagingFetch(pages: { result: unknown[]; pagedResultsCookie: string | null }[]) {
    let i = 0;
    return vi.fn(async () => jsonRes(pages[Math.min(i++, pages.length - 1)]));
}

const baseOpts = (root: string) => ({
    archiveRoot: path.join(root, "prod", "log-data"),
    tenantBaseUrl: "https://tenant.example.com",
    apiKey: "k",
    apiSecret: "s",
    sleepFn: async () => {},            // no real waiting
    nowMs: () => 0,                     // deterministic pacing
    signal: new AbortController().signal,
    pageSize: 1000,
});

describe("runLogPull", () => {
    it("pages a source to exhaustion, stores entries, and records the covered range", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);

        const fetchFn = pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z"), logEntry("b", "2026-06-02T02:00:00Z")], pagedResultsCookie: "c2" },
            { result: [logEntry("c", "2026-06-02T03:00:00Z")], pagedResultsCookie: null },
        ]);

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn });

        // Stored to the archive (deduped) and readable back.
        const stored = readRange(baseOpts(root).archiveRoot, "am-authentication", FROM, TO);
        expect(stored.map((e) => e.payload._id)).toEqual(["a", "b", "c"]);

        // Job + progress finished.
        const done = reg.getJob(job.id)!;
        expect(done.status).toBe("completed");
        expect(done.progress[0]).toMatchObject({ status: "done", fetched: 3, stored: 3, cookie: null });

        // Manifest covered-range + entryCount.
        const manifest = readManifest(baseOpts(root).archiveRoot);
        expect(manifest.sources["am-authentication"].coveredRanges).toEqual([{ from: FROM, to: TO }]);
        expect(manifest.sources["am-authentication"].entryCount).toBe(3);

        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("dedupes on a re-pull of the same window (stored 0, range unchanged)", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);

        const pages = () => pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z")], pagedResultsCookie: null },
        ]);

        const job1 = reg.startJob("prod", ["am-authentication"], FROM, TO);
        await runLogPull({ ...baseOpts(root), job: job1, registry: reg, fetchFn: pages() });
        reg.setJobStatus(job1.id, "completed"); // ensure terminal so a 2nd job is allowed

        const job2 = reg.startJob("prod", ["am-authentication"], FROM, TO);
        await runLogPull({ ...baseOpts(root), job: job2, registry: reg, fetchFn: pages() });

        expect(reg.getJob(job2.id)!.progress[0]).toMatchObject({ fetched: 1, stored: 0 });
        const stored = readRange(baseOpts(root).archiveRoot, "am-authentication", FROM, TO);
        expect(stored).toHaveLength(1); // not duplicated
    });

    it("marks a source failed on a non-2xx page and still completes the job", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const fetchFn = vi.fn(async () => ({
            status: 500, ok: false,
            headers: { get: () => null },
            text: async () => "server error",
            json: async () => ({}),
        } as unknown as Response));

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn });

        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("completed");
        expect(j.progress[0].status).toBe("failed");
        expect(j.progress[0].error).toContain("500");
    });

    it("does nothing and marks aborted when the signal is already aborted", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const ac = new AbortController();
        ac.abort();
        const fetchFn = vi.fn();

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn, signal: ac.signal });

        expect(fetchFn).not.toHaveBeenCalled();
        expect(reg.getJob(job.id)!.status).toBe("aborted");
    });

    it("resumes a source from its persisted cookie", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        // Simulate an interrupted run that saved a mid-source cursor.
        reg.updateProgress(job.id, "am-authentication", { status: "running", fetched: 5, stored: 5, cookie: "mid-cookie" });
        const resumed = reg.getJob(job.id)!;

        const seenUrls: string[] = [];
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            seenUrls.push(String(url));
            return jsonRes({ result: [logEntry("z", "2026-06-02T05:00:00Z")], pagedResultsCookie: null });
        });

        await runLogPull({ ...baseOpts(root), job: resumed, registry: reg, fetchFn });

        expect(seenUrls[0]).toContain("_pagedResultsCookie=mid-cookie");
        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("completed");
        expect(j.progress[0]).toMatchObject({ status: "done", fetched: 6, stored: 6 });
    });

    it("marks a source failed (not stuck on running) when a page body fails to parse", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const fetchFn = vi.fn(async () => ({
            status: 200, ok: true,
            headers: { get: () => null },
            json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
            text: async () => "<html>error</html>",
        } as unknown as Response));

        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn });

        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("completed"); // terminal, NOT stuck on "running"
        expect(j.progress[0].status).toBe("failed");
        expect(j.progress[0].error).toContain("JSON");
    });

    it("suspends to a resumable state under heap pressure, persisting the cursor", async () => {
        const root = tmpEnvsRoot();
        const reg = createLogRegistry(root);
        const job = reg.startJob("prod", ["am-authentication"], FROM, TO);
        const fetchFn = pagingFetch([
            { result: [logEntry("a", "2026-06-02T01:00:00Z")], pagedResultsCookie: "c2" },
            { result: [logEntry("b", "2026-06-02T02:00:00Z")], pagedResultsCookie: null },
        ]);

        // Heap pressure trips right after the first page is stored.
        await runLogPull({ ...baseOpts(root), job, registry: reg, fetchFn, heapPressureFn: () => true });

        const j = reg.getJob(job.id)!;
        expect(j.status).toBe("suspended");          // stable resumable state, not "suspending"
        expect(j.finishedAt).toBeUndefined();        // not terminal
        expect(j.progress[0].status).toBe("running");
        expect(j.progress[0].cookie).toBe("c2");     // cursor persisted for resume
        expect(fetchFn).toHaveBeenCalledTimes(1);    // stopped after the first page
    });
});
