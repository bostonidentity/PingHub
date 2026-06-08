import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { inspectStoredRaw, pruneRawRetention, removeRaw, RAW_RETENTION } from "./journey-raw";
import { rawDir, rawWindowPath } from "./journey-report-paths";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "journey-raw-"));
}

const line = (o: unknown) => JSON.stringify(o) + "\n";
const completed = (ts: string, txn: string, tree: string, result: "SUCCESSFUL" | "FAILED") =>
  ({ timestamp: ts, payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: txn, result, entries: [{ info: { treeName: tree } }] } });
const node = (ts: string, txn: string, display: string, outcome: string) =>
  ({ timestamp: ts, payload: { eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: txn, entries: [{ info: { displayName: display, nodeOutcome: outcome } }] } });

/** Write events as a retained raw window file. */
function writeWindow(root: string, jobId: string, win: number, events: unknown[]) {
  const p = rawWindowPath(root, jobId, win);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, events.map(line).join(""));
}

describe("inspectStoredRaw", () => {
  it("returns null when no raw is retained for the job", () => {
    expect(inspectStoredRaw(tmpRoot(), "missing")).toBeNull();
  });

  it("re-analyzes a single retained window into per-attempt + node detail", () => {
    const root = tmpRoot();
    writeWindow(root, "j1", 0, [
      node("2026-06-03T10:00:01Z", "t1", "Forgot Password OTP", "Failure"),
      completed("2026-06-03T10:00:02Z", "t1", "forgotPassword", "FAILED"),
      completed("2026-06-03T10:00:03Z", "t2", "forgotPassword", "SUCCESSFUL"),
    ]);
    const r = inspectStoredRaw(root, "j1")!;
    expect(r).not.toBeNull();
    expect(r.summary.attempts).toBe(2);
    const fp = r.perJourney.find((j) => j.treeName === "forgotPassword")!;
    expect(fp.fail).toBe(1);
    expect(fp.topFailureNodes).toEqual([{ node: "Forgot Password OTP", count: 1 }]);
    expect(r.attempts.find((a) => a.transactionId === "t1")!.failureNode).toBe("Forgot Password OTP");
  });

  it("filters to a single journey when treeName is given", () => {
    const root = tmpRoot();
    writeWindow(root, "j2", 0, [
      completed("2026-06-03T10:00:02Z", "t1", "forgotPassword", "FAILED"),
      completed("2026-06-03T10:00:03Z", "t2", "MasterLogin", "SUCCESSFUL"),
    ]);
    const r = inspectStoredRaw(root, "j2", { treeName: "forgotPassword" })!;
    expect(r.attempts.every((a) => a.treeName === "forgotPassword")).toBe(true);
    expect(r.perJourney.map((j) => j.treeName)).toEqual(["forgotPassword"]);
  });

  it("merges across multiple retained windows", () => {
    const root = tmpRoot();
    writeWindow(root, "j3", 0, [completed("2026-06-03T10:00:02Z", "a", "forgotPassword", "FAILED")]);
    writeWindow(root, "j3", 1, [completed("2026-06-04T10:00:02Z", "b", "forgotPassword", "FAILED")]);
    const r = inspectStoredRaw(root, "j3")!;
    expect(r.perJourney.find((j) => j.treeName === "forgotPassword")!.fail).toBe(2);
    expect(r.attempts.length).toBe(2);
  });

  it("caps the returned attempt sample and flags truncation", () => {
    const root = tmpRoot();
    const events = Array.from({ length: 10 }, (_, i) => completed(`2026-06-03T10:00:0${i}Z`, `t${i}`, "forgotPassword", "FAILED"));
    writeWindow(root, "j4", 0, events);
    const r = inspectStoredRaw(root, "j4", { maxAttempts: 4 })!;
    expect(r.attempts.length).toBe(4);
    expect(r.attemptsTruncated).toBe(true);
    expect(r.summary.attempts).toBe(10); // summary still reflects the full count
  });
});

describe("pruneRawRetention", () => {
  it("keeps the newest N job dirs and removes older ones", () => {
    const root = tmpRoot();
    for (let i = 0; i < RAW_RETENTION + 2; i++) {
      writeWindow(root, `job${i}`, 0, [completed("2026-06-03T10:00:00Z", "t", "x", "FAILED")]);
      // Stagger mtimes so "newest" is well-defined (job0 oldest … jobN newest).
      const t = new Date(2026, 0, 1, 0, 0, i);
      fs.utimesSync(rawDir(root, `job${i}`), t, t);
    }
    pruneRawRetention(root);
    expect(fs.existsSync(rawDir(root, "job0"))).toBe(false); // oldest pruned
    expect(fs.existsSync(rawDir(root, "job1"))).toBe(false);
    expect(fs.existsSync(rawDir(root, `job${RAW_RETENTION + 1}`))).toBe(true); // newest kept
  });

  it("is a no-op when under the cap", () => {
    const root = tmpRoot();
    writeWindow(root, "only", 0, [completed("2026-06-03T10:00:00Z", "t", "x", "FAILED")]);
    pruneRawRetention(root);
    expect(fs.existsSync(rawDir(root, "only"))).toBe(true);
  });
});

describe("removeRaw", () => {
  it("deletes a job's retained raw", () => {
    const root = tmpRoot();
    writeWindow(root, "gone", 0, [completed("2026-06-03T10:00:00Z", "t", "x", "FAILED")]);
    removeRaw(root, "gone");
    expect(fs.existsSync(rawDir(root, "gone"))).toBe(false);
  });
});
