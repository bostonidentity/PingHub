import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { runJourneyReport } from "./journey-report-runner";
import { createJourneyReportRegistry } from "./journey-report-registry";
import { reportPath } from "./journey-report-paths";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "journey-run-"));
}

const FROM = "2026-06-03T00:00:00Z";
const TO = "2026-06-04T00:00:00Z";

/** A login-completed event the analyzer will turn into one attempt. */
function loginEvent(txn: string, ts: string, result = "SUCCESSFUL") {
  return {
    timestamp: ts,
    payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: txn, treeName: "Login", result },
  };
}

/** Minimal Response stub with the surface the runner + fetchLogPage read. */
function jsonRes(body: unknown, status = 200): Response {
  const r = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return r; },
  };
  return r as unknown as Response;
}

function pagingFetch(pages: { result: unknown[]; pagedResultsCookie: string | null }[]) {
  let i = 0;
  return vi.fn(async () => jsonRes(pages[Math.min(i++, pages.length - 1)]));
}

const baseOpts = (root: string) => ({
  reportRoot: path.join(root, "prod", "journey-reports"),
  tenantBaseUrl: "https://tenant.example.com",
  apiKey: "k",
  apiSecret: "s",
  sleepFn: async () => {},
  nowMs: () => 0,
  heapPressureFn: () => false,
  signal: new AbortController().signal,
});

describe("runJourneyReport", () => {
  it("pages to exhaustion, stages events, writes the report, and completes", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = pagingFetch([
      { result: [loginEvent("t1", "2026-06-03T01:00:00Z"), loginEvent("t2", "2026-06-03T02:00:00Z", "FAILED")], pagedResultsCookie: "c2" },
      { result: [loginEvent("t3", "2026-06-03T03:00:00Z")], pagedResultsCookie: null },
    ]);

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.reportReady).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const file = reportPath(baseOpts(root).reportRoot, job.id);
    const rep = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(rep.source).toBe("live");
    expect(rep.rawFetched).toBe(3);
    expect(rep.pagesFetched).toBe(2);
    expect(rep.eventsFetched).toBe(3);
    expect(rep.summary.attempts).toBe(3);
    expect(rep.window).toEqual({ from: FROM, to: TO });
  });

  it("caps at maxEvents and marks the report truncated", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1 });
    const fetchFn = pagingFetch([
      { result: [loginEvent("t1", "2026-06-03T01:00:00Z"), loginEvent("t2", "2026-06-03T02:00:00Z")], pagedResultsCookie: "c2" },
    ]);

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.progress.matched).toBe(1);
    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.truncated).toBe(true);
  });

  it("marks the job failed (terminal) on a non-2xx page", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = vi.fn(async () => jsonRes({ message: "boom" }, 500));

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("failed");
    expect(done.fatalError).toContain("500");
    expect(done.reportReady).toBeFalsy();
  });

  it("suspends under heap pressure, persisting the cookie, then resumes to completion", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = pagingFetch([
      { result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: "c2" },
      { result: [loginEvent("t2", "2026-06-03T02:00:00Z")], pagedResultsCookie: null },
    ]);

    // Heap pressure trips right after the first page.
    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn, heapPressureFn: () => true });

    let s = reg.getJob(job.id)!;
    expect(s.status).toBe("suspended");
    expect(s.progress.cookie).toBe("c2");
    expect(s.progress.byteLength).toBeGreaterThan(0);
    expect(s.reportReady).toBeFalsy();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Resume: continues from the cookie, exhausts, completes.
    await runJourneyReport({ ...baseOpts(root), job: reg.getJob(job.id)!, registry: reg, fetchFn });
    s = reg.getJob(job.id)!;
    expect(s.status).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.eventsFetched).toBe(2); // both pages' events, no double-count
  });

  it("finalizes to 'aborted' on a plain abort", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const ac = new AbortController();
    const fetchFn = vi.fn(async () => { ac.abort(); return jsonRes({ result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: "c2" }); });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn, signal: ac.signal });

    expect(reg.getJob(job.id)!.status).toBe("aborted");
  });
});
