import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { saveReportTo, listReportsIn, getReportFrom } from "./journey-report-history";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jr-history-"));
}
const report = (over: Record<string, unknown> = {}) => ({
  summary: { attempts: 3, success: 2, fail: 1, incomplete: 0, transactions: 3, eventsProcessed: 3 },
  perJourney: [{ treeName: "Login", attempts: 3, success: 2, fail: 1, incomplete: 0, failRate: 0.33, innerOnly: false, topFailureNodes: [] }],
  attempts: [],
  window: { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" },
  env: "prod",
  source: "live",
  generatedAt: "2026-06-02T03:04:05.000Z",
  durationMs: 1234,
  selectedJourneys: ["Login"],
  ...over,
});

describe("journey report history", () => {
  it("saves a report and lists its metadata (newest first)", () => {
    const dir = tmpDir();
    const a = saveReportTo(dir, report());
    const b = saveReportTo(dir, report({ source: "archive", generatedAt: "2026-06-03T00:00:00.000Z", summary: { attempts: 9, success: 9, fail: 0, incomplete: 0 } }));

    const list = listReportsIn(dir);
    expect(list.map((m) => m.id)).toEqual([b.id, a.id]); // newest first
    expect(list[0]).toMatchObject({ source: "archive", attempts: 9, generatedAt: "2026-06-03T00:00:00.000Z" });
    expect(list[1]).toMatchObject({ source: "live", attempts: 3, fail: 1, selectedJourneys: ["Login"], durationMs: 1234 });
  });

  it("dedupes a double-save of the same report (same generatedAt)", () => {
    const dir = tmpDir();
    const r = report({ generatedAt: "2026-06-05T10:00:00.000Z" });
    const a = saveReportTo(dir, r);
    const b = saveReportTo(dir, r); // same generatedAt → no new entry
    expect(b.id).toBe(a.id);
    expect(listReportsIn(dir)).toHaveLength(1);
    // A genuinely different generation (new generatedAt) is kept.
    saveReportTo(dir, report({ generatedAt: "2026-06-05T10:01:00.000Z" }));
    expect(listReportsIn(dir)).toHaveLength(2);
  });

  it("round-trips the full report by id and rejects bad ids", () => {
    const dir = tmpDir();
    const m = saveReportTo(dir, report());
    const got = getReportFrom(dir, m.id) as Record<string, unknown>;
    expect((got.summary as Record<string, number>).attempts).toBe(3);
    expect(getReportFrom(dir, "../etc/passwd")).toBeNull();
    expect(getReportFrom(dir, "nope")).toBeNull();
  });

  it("prunes to the most-recent 50, deleting old files", () => {
    const dir = tmpDir();
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const generatedAt = `2026-06-05T10:${String(i).padStart(2, "0")}:00.000Z`; // distinct per save
      ids.push(saveReportTo(dir, report({ generatedAt })).id);
    }
    const list = listReportsIn(dir);
    expect(list).toHaveLength(50);
    // The 5 oldest report files were deleted.
    for (const oldId of ids.slice(0, 5)) {
      expect(fs.existsSync(path.join(dir, `${oldId}.json`))).toBe(false);
    }
    // The newest is still retrievable.
    expect(getReportFrom(dir, ids[ids.length - 1])).not.toBeNull();
  });
});
