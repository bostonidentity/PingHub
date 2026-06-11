// Persistent, per-environment history of generated Journey-history reports
// (both Live and Archive). Each saved report is a `<id>.json` file under
// `<env>/journey-reports/history/`, with a lightweight `index.json` of metadata
// so listing doesn't read every full report. Capped to the most-recent N.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { journeyReportRoot } from "./journey-report-paths";

const MAX_HISTORY = 50;
const ID_RE = /^[0-9]+-[a-f0-9]{8}$/;

export interface JourneyHistoryMeta {
  id: string;
  /** ISO time the report was generated (falls back to save time). */
  generatedAt: string;
  source: "live" | "archive";
  window?: { from: string; to: string };
  selectedJourneys?: string[];
  attempts: number;
  success: number;
  fail: number;
  incomplete: number;
  rollupOnly?: boolean;
  durationMs?: number;
}

function indexPath(dir: string): string {
  return path.join(dir, "index.json");
}

function readIndex(dir: string): JourneyHistoryMeta[] {
  try {
    const arr = JSON.parse(fs.readFileSync(indexPath(dir), "utf-8"));
    return Array.isArray(arr) ? (arr as JourneyHistoryMeta[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(dir: string, entries: JourneyHistoryMeta[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${indexPath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, indexPath(dir));
}

function metaFromReport(id: string, report: Record<string, unknown>): JourneyHistoryMeta {
  const summary = (report.summary ?? {}) as Record<string, unknown>;
  const w = report.window as { from?: unknown; to?: unknown } | undefined;
  return {
    id,
    generatedAt: typeof report.generatedAt === "string" ? report.generatedAt : new Date().toISOString(),
    source: report.source === "archive" ? "archive" : "live",
    window: w && typeof w.from === "string" && typeof w.to === "string" ? { from: w.from, to: w.to } : undefined,
    selectedJourneys: Array.isArray(report.selectedJourneys) ? (report.selectedJourneys as string[]) : undefined,
    attempts: Number(summary.attempts) || 0,
    success: Number(summary.success) || 0,
    fail: Number(summary.fail) || 0,
    incomplete: Number(summary.incomplete) || 0,
    rollupOnly: report.rollupOnly === true,
    durationMs: typeof report.durationMs === "number" ? report.durationMs : undefined,
  };
}

// ── dir-based core (testable without env wiring) ────────────────────────────

/** Save a report to `dir`, prepend its metadata to the index, prune to MAX_HISTORY. */
export function saveReportTo(dir: string, report: unknown): JourneyHistoryMeta {
  fs.mkdirSync(dir, { recursive: true });
  const rep = (report ?? {}) as Record<string, unknown>;
  // Dedupe a double-save of the same report (e.g. StrictMode / re-render): a report's
  // generatedAt is a unique completion timestamp, so an equal newest entry is the same one.
  const genAt = typeof rep.generatedAt === "string" ? rep.generatedAt : undefined;
  const existing = readIndex(dir);
  if (genAt && existing[0]?.generatedAt === genAt) return existing[0];
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(report));
  const meta = metaFromReport(id, (report ?? {}) as Record<string, unknown>);
  const all = [meta, ...readIndex(dir)];
  const kept = all.slice(0, MAX_HISTORY);
  for (const stale of all.slice(MAX_HISTORY)) {
    try { fs.unlinkSync(path.join(dir, `${stale.id}.json`)); } catch { /* best-effort */ }
  }
  writeIndex(dir, kept);
  return meta;
}

/** Newest-first metadata for every saved report in `dir`. */
export function listReportsIn(dir: string): JourneyHistoryMeta[] {
  return readIndex(dir);
}

/** The full saved report for `id`, or null. `id` is validated against traversal. */
export function getReportFrom(dir: string, id: string): unknown | null {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf-8"));
  } catch {
    return null;
  }
}

// ── env wrappers ────────────────────────────────────────────────────────────

function historyDir(env: string): string {
  return path.join(journeyReportRoot(env), "history");
}

export function saveHistoryReport(env: string, report: unknown): JourneyHistoryMeta {
  return saveReportTo(historyDir(env), report);
}
export function listHistoryReports(env: string): JourneyHistoryMeta[] {
  return listReportsIn(historyDir(env));
}
export function getHistoryReport(env: string, id: string): unknown | null {
  return getReportFrom(historyDir(env), id);
}
