import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { runJourneyReport } from "./journey-report-runner";
import { AUTO_RECOVERY_MAX_EPISODES } from "./journey-report-types";
import { analyzeJourneyHistory } from "./journey-history";
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
    expect(typeof rep.durationMs).toBe("number");
    expect(rep.durationMs).toBeGreaterThanOrEqual(0);
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

  it("summaryOnly narrows the server filter and drops node events", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000, summaryOnly: true });
    const urls: string[] = [];
    const nodeEvent = {
      timestamp: "2026-06-03T01:30:00Z",
      payload: { eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: "t1", treeName: "Login" },
    };
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      // AIC would not return node events under the narrow filter, but even if one
      // slips through, the runner must not stage it.
      return jsonRes({ result: [loginEvent("t1", "2026-06-03T01:00:00Z"), nodeEvent], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    // Narrow filter: tree events only, no node clause.
    const decoded = decodeURIComponent(urls[0].replace(/\+/g, " "));
    expect(decoded).toContain('(/payload/eventName co "AM-TREE-LOGIN-")');
    expect(decoded).not.toContain("AM-NODE-LOGIN-COMPLETED");

    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.eventsFetched).toBe(1); // node event not staged
    expect(rep.summary.attempts).toBe(1);
  });

  it("server-side filters by selected journeys, and falls back above the cap", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000, treeNames: ["Login", "Signup"] });
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonRes({ result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const decoded = decodeURIComponent(urls[0].replace(/\+/g, " "));
    expect(decoded).toContain('/payload/entries/info/treeName eq "Login" or /payload/entries/info/treeName eq "Signup"');
    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.selectedJourneys).toEqual(["Login", "Signup"]);

    // Above the cap → no server clause (falls back to analysis-time filtering).
    const many = Array.from({ length: 26 }, (_, i) => `J${i}`);
    const job2 = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000, treeNames: many });
    const urls2: string[] = [];
    const fetchFn2 = vi.fn(async (url: string | URL | Request) => {
      urls2.push(String(url));
      return jsonRes({ result: [], pagedResultsCookie: null });
    });
    await runJourneyReport({ ...baseOpts(root), job: job2, registry: reg, fetchFn: fetchFn2 });
    expect(decodeURIComponent(urls2[0])).not.toContain("entries/info/treeName");
  });

  it("chunks a multi-day range into windows and merges into a rollup-only report", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    // 3-day range, 1-day windows → 3 windows.
    const job = reg.startJob("prod", {
      from: "2026-06-01T00:00:00Z", to: "2026-06-04T00:00:00Z", maxEvents: 1000, windowHours: 24,
    });
    const winUrls: string[] = [];
    // Each window returns one completed login on its own day; cookie null = exhausted.
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      winUrls.push(String(url));
      const u = new URL(String(url));
      const begin = u.searchParams.get("beginTime") ?? "";
      const day = begin.slice(8, 10); // "01" | "02" | "03"
      const result = day === "02" ? "FAILED" : "SUCCESSFUL";
      return jsonRes({ result: [loginEvent(`t${day}`, `2026-06-${day}T01:00:00Z`, result)], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(3); // one page per window
    // Each window queried its own day.
    expect(winUrls.map((u) => new URL(u).searchParams.get("beginTime")!.slice(0, 10)))
      .toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);

    // AIC rejects queries spanning >1 day: every sub-query must be ≤ 24h.
    for (const u of winUrls) {
      const q = new URL(u).searchParams;
      const span = Date.parse(q.get("endTime")!) - Date.parse(q.get("beginTime")!);
      expect(span).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    }

    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.rollupOnly).toBe(true);
    expect(rep.windows).toBe(3);
    expect(rep.attempts).toEqual([]);
    expect(rep.summary.attempts).toBe(3); // merged across windows
    expect(rep.summary.success).toBe(2);
    expect(rep.summary.fail).toBe(1);
    expect(rep.eventsFetched).toBe(3);
    // All three days are the same tree → one merged per-journey row.
    expect(rep.perJourney).toHaveLength(1);
    expect(rep.perJourney[0].attempts).toBe(3);
  });

  it("resumes a chunked run, skipping already-completed windows", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", {
      from: "2026-06-01T00:00:00Z", to: "2026-06-04T00:00:00Z", maxEvents: 1000, windowHours: 24,
    });
    // Simulate an interrupted run: window 0 already paged + folded into `partial`.
    const w0 = analyzeJourneyHistory([{ timestamp: "2026-06-01T01:00:00Z", payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: "t0", treeName: "Login", result: "SUCCESSFUL" } }]);
    reg.updateProgress(job.id, {
      windowsTotal: 3, windowsDone: 1, completedWindows: [0],
      partial: { rollup: { summary: w0.summary, perJourney: w0.perJourney }, eventNameCounts: {}, rawTotal: 1, matchedTotal: 1, pagesTotal: 1, anyTruncated: false },
    });

    const days: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const day = new URL(String(url)).searchParams.get("beginTime")!.slice(0, 10);
      days.push(day);
      const d = day.slice(8, 10);
      return jsonRes({ result: [loginEvent(`t${d}`, `${day}T01:00:00Z`)], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job: reg.getJob(job.id)!, registry: reg, fetchFn });

    expect(reg.getJob(job.id)!.status).toBe("completed");
    // Window 0 was already done → only windows 1 and 2 are re-fetched.
    expect(days.sort()).toEqual(["2026-06-02", "2026-06-03"]);
    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.summary.attempts).toBe(3); // pre-folded window 0 + windows 1 and 2
  });

  it("limits in-flight windows to windowConcurrency", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    // 6-day range, 1-day windows → 6 windows; cap concurrency at 2.
    const job = reg.startJob("prod", {
      from: "2026-06-01T00:00:00Z", to: "2026-06-07T00:00:00Z", maxEvents: 1000, windowHours: 24, windowConcurrency: 2,
    });
    let inFlight = 0, maxInFlight = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot so overlap is observable
      inFlight--;
      const d = new URL(String(url)).searchParams.get("beginTime")!.slice(8, 10);
      return jsonRes({ result: [loginEvent(`t${d}`, `2026-06-${d}T01:00:00Z`)], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    expect(reg.getJob(job.id)!.status).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(2); // reaches the cap, never exceeds it
    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.summary.attempts).toBe(6);
  });

  it("pauses (suspended) instead of failing on a sustained throughput 429", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    // 429 on every attempt → fetchLogPage exhausts its retries → rate-limited.
    const fetchFn = vi.fn(async () => jsonRes({ code: 429, reason: "Too Many Requests", errors: ["Rate Limit Exceeded"] }, 429));

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("suspended");      // resumable, not failed
    expect(done.fatalError).toMatch(/rate limited/i);
    expect(done.reportReady).toBeFalsy();
  });

  it("records each retried 429 in progress (live throttle feedback)", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonRes({ code: 429, errors: ["Rate Limit Exceeded"] }, 429); // first try throttled
      return jsonRes({ result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");          // 429 was retried, then succeeded
    expect(done.progress.throttles).toBe(1);        // the reject was surfaced, not swallowed
    expect(done.progress.lastThrottleAttempt).toBe(1);
  });

  it("clears the throttling flag once pages flow cleanly again", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    // One 429 (→ throttling active) then several clean pages → flag clears by the end.
    let calls = 0;
    const cookies: (string | null)[] = ["c1", "c2", "c3", "c4", null];
    const fetchFn = vi.fn(async () => {
      if (calls === 0) { calls++; return jsonRes({ code: 429, errors: ["Rate Limit Exceeded"] }, 429); }
      const cookie = cookies[Math.min(calls - 1, cookies.length - 1)];
      calls++;
      return jsonRes({ result: [loginEvent(`t${calls}`, "2026-06-03T01:00:00Z")], pagedResultsCookie: cookie });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.progress.throttles).toBe(1);     // the 429 was recorded
    expect(done.progress.throttling).toBe(false); // ...but the live flag cleared on recovery
  });

  it("surfaces live page progress + in-flight windows for chunked runs", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    // 2 windows, 2 pages each → 4 pages total fetched.
    const job = reg.startJob("prod", {
      from: "2026-06-01T00:00:00Z", to: "2026-06-03T00:00:00Z", maxEvents: 1000, windowHours: 24, windowConcurrency: 2,
    });
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const cookie = new URL(String(url)).searchParams.get("_pagedResultsCookie");
      const d = new URL(String(url)).searchParams.get("beginTime")!.slice(8, 10);
      return cookie
        ? jsonRes({ result: [loginEvent(`t${d}b`, `2026-06-${d}T02:00:00Z`)], pagedResultsCookie: null })
        : jsonRes({ result: [loginEvent(`t${d}a`, `2026-06-${d}T01:00:00Z`)], pagedResultsCookie: "c1" });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.progress.livePages).toBe(4);                 // motion: every page ticked
    expect(typeof done.progress.windowsInFlight).toBe("number"); // in-flight count surfaced
  });

  it("auto-lowers in-flight windows under sustained throttling", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    // 10 windows, start at 4 parallel; every window's first fetch 429s → governor
    // ratchets concurrency down to 1, so the back windows run far below the cap.
    const job = reg.startJob("prod", {
      from: "2026-06-01T00:00:00Z", to: "2026-06-11T00:00:00Z", maxEvents: 1000, windowHours: 24, windowConcurrency: 4,
    });
    const attemptsByWindow = new Map<string, number>();
    let inFlight = 0, maxInFlight = 0, lateMaxInFlight = 0, completed = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const begin = new URL(String(url)).searchParams.get("beginTime")!;
      const n = (attemptsByWindow.get(begin) ?? 0) + 1;
      attemptsByWindow.set(begin, n);
      if (n === 1) return jsonRes({ code: 429, errors: ["Rate Limit Exceeded"] }, 429); // throttle every window once
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Once half the windows are done, concurrency should have ratcheted to 1 —
      // a fixed pool would still be running ~4 in flight here.
      if (completed >= 5) lateMaxInFlight = Math.max(lateMaxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      completed++;
      const d = begin.slice(8, 10);
      return jsonRes({ result: [loginEvent(`t${d}`, `2026-06-${d}T01:00:00Z`)], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    expect(reg.getJob(job.id)!.status).toBe("completed");
    expect(maxInFlight).toBe(4);       // reaches the configured cap initially
    expect(lateMaxInFlight).toBe(1);   // ...then ratchets down to 1 under sustained pressure
    const rep = JSON.parse(fs.readFileSync(reportPath(baseOpts(root).reportRoot, job.id), "utf-8"));
    expect(rep.summary.attempts).toBe(10);        // all windows still processed
  });

  it("backs off at least 5s per 429 (doesn't trust a low Retry-After)", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    // AIC asks for only 3s; the runner should floor it to 5s. No real waiting (sleepFn noop).
    const res429 = { status: 429, ok: false, headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "3" : null) }, json: async () => ({ code: 429 }), text: async () => "rate limit", clone() { return res429; } } as unknown as Response;
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      if (calls++ === 0) return res429;
      return jsonRes({ result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.progress.lastThrottleWaitMs).toBe(5000); // 3s Retry-After floored to 5s
  });

  it("auto-recovers from a sustained throughput 429 and completes", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    // First page exhausts its retry budget (→ rate-limited), then a cooldown retry succeeds.
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls <= 10) return jsonRes({ code: 429, errors: ["Rate Limit Exceeded"] }, 429);
      return jsonRes({ result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: null });
    });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("completed");        // recovered without manual resume
    expect(done.progress.recoveryAttempt).toBe(1); // it took one cooldown-and-retry
    expect(done.progress.recovering).toBe(false);  // not stuck cooling down
  });

  it("falls back to a manual pause after the auto-recovery cap", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = vi.fn(async () => jsonRes({ code: 429, errors: ["Rate Limit Exceeded"] }, 429));

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const done = reg.getJob(job.id)!;
    expect(done.status).toBe("suspended");                  // resumable, not failed
    expect(done.progress.recoveryAttempt).toBe(AUTO_RECOVERY_MAX_EPISODES);
    expect(done.progress.recovering).toBe(false);
    expect(done.fatalError).toMatch(/auto-retr/i);
  });

  it("aborts cleanly if cancelled during an auto-recovery cooldown", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = vi.fn(async () => jsonRes({ code: 429, errors: ["Rate Limit Exceeded"] }, 429));
    const ctl = new AbortController();
    // Cancel the moment the run enters a cooldown (recovering flag is set just before the wait).
    const sleepFn = async () => { if (reg.getJob(job.id)?.progress.recovering) ctl.abort(); };

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn, signal: ctl.signal, sleepFn });

    expect(reg.getJob(job.id)!.status).toBe("aborted");
  });

  it("still fails (terminal) on a volume-quota 429", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = vi.fn(async () => jsonRes({ message: "You have requested more log data than permitted in 24 hours" }, 429));

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    expect(reg.getJob(job.id)!.status).toBe("failed");
  });

  it("surfaces recent matched events in progress for the live feed", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = pagingFetch([
      { result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: null },
    ]);

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn });

    const recent = reg.getJob(job.id)!.progress.recentEvents;
    expect(recent && recent.length).toBeGreaterThan(0);
    expect(recent![0]).toMatchObject({ eventName: "AM-TREE-LOGIN-COMPLETED", tree: "Login" });
    expect(typeof recent![0].ts).toBe("string");
  });

  it("waits the default 5s request delay between pages", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000 });
    const fetchFn = pagingFetch([
      { result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: "c2" },
      { result: [loginEvent("t2", "2026-06-03T02:00:00Z")], pagedResultsCookie: null },
    ]);
    const waits: number[] = [];
    const sleepFn = vi.fn(async (ms: number) => { waits.push(ms); });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn, sleepFn });

    expect(waits.some((w) => w >= 5000)).toBe(true); // 5s floor applied between pages
  });

  it("respects a custom requestDelayMs (0 = no floor)", async () => {
    const root = tmpRoot();
    const reg = createJourneyReportRegistry(root);
    const job = reg.startJob("prod", { from: FROM, to: TO, maxEvents: 1000, requestDelayMs: 0 });
    const fetchFn = pagingFetch([
      { result: [loginEvent("t1", "2026-06-03T01:00:00Z")], pagedResultsCookie: "c2" },
      { result: [loginEvent("t2", "2026-06-03T02:00:00Z")], pagedResultsCookie: null },
    ]);
    const waits: number[] = [];
    const sleepFn = vi.fn(async (ms: number) => { waits.push(ms); });

    await runJourneyReport({ ...baseOpts(root), job, registry: reg, fetchFn, sleepFn });

    expect(waits.every((w) => w < 5000)).toBe(true); // no 5s floor when delay is 0
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
