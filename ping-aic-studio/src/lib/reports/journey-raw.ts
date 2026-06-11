import fs from "node:fs";
import path from "node:path";
import { analyzeJourneyHistory, emptyRollup, mergeRollup, type JourneyAttempt, type RawAuthEvent } from "./journey-history";
import { filterEventsByJourneys } from "./journey-filter";
import { rawRoot, rawDir } from "./journey-report-paths";

/** How many runs' raw to keep on disk per env (opt-in retention). */
export const RAW_RETENTION = 10;

/** Default cap on per-attempt rows returned by an inspection (transport size). */
const DEFAULT_MAX_ATTEMPTS = 5_000;

/** A re-analyzed view of a run's retained raw, scoped to one journey if requested. */
export interface InspectResult {
  summary: ReturnType<typeof analyzeJourneyHistory>["summary"];
  attempts: JourneyAttempt[];
  perJourney: ReturnType<typeof analyzeJourneyHistory>["perJourney"];
  /** True when `attempts` is a capped sample (summary still reflects the full counts). */
  attemptsTruncated: boolean;
}

function readNdjson(file: string): RawAuthEvent[] {
  const out: RawAuthEvent[] = [];
  for (const ln of fs.readFileSync(file, "utf-8").split("\n")) {
    const s = ln.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as RawAuthEvent); } catch { /* skip a torn line */ }
  }
  return out;
}

/**
 * Re-analyze a run's retained raw NDJSON (offline — no AIC call), optionally
 * filtered to a single journey. Each retained window is analyzed independently and
 * the per-journey rollups merged (same model as the live run), so memory stays
 * bounded. Returns null when nothing is retained for the job.
 *
 * Only recovers what was originally fetched: a run pulled with "Rates only" has no
 * AM-NODE events, so failure-node detail will be absent.
 */
export function inspectStoredRaw(
  reportRoot: string,
  jobId: string,
  opts: { treeName?: string; maxAttempts?: number } = {},
): InspectResult | null {
  const dir = rawDir(reportRoot, jobId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort();
  if (files.length === 0) return null;

  const cap = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts: JourneyAttempt[] = [];
  let rollup = emptyRollup();
  let totalAttempts = 0;

  for (const f of files) {
    const events = readNdjson(path.join(dir, f));
    const scoped = opts.treeName ? filterEventsByJourneys(events, [opts.treeName]) : events;
    const rep = analyzeJourneyHistory(scoped);
    rollup = mergeRollup(rollup, { summary: rep.summary, perJourney: rep.perJourney });
    totalAttempts += rep.attempts.length;
    for (const a of rep.attempts) {
      if (attempts.length < cap) attempts.push(a);
    }
  }

  return {
    summary: rollup.summary,
    attempts,
    perJourney: rollup.perJourney,
    attemptsTruncated: totalAttempts > attempts.length,
  };
}

/** Delete one run's retained raw (best-effort). */
export function removeRaw(reportRoot: string, jobId: string): void {
  try { fs.rmSync(rawDir(reportRoot, jobId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Keep only the newest `keep` runs' raw (by mtime); prune the rest. Best-effort. */
export function pruneRawRetention(reportRoot: string, keep: number = RAW_RETENTION): void {
  const root = rawRoot(reportRoot);
  let entries: { name: string; mtimeMs: number }[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtimeMs: statMtime(path.join(root, e.name)) }));
  } catch { return; } // no .raw dir yet
  if (entries.length <= keep) return;
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1)); // newest first
  for (const stale of entries.slice(keep)) {
    try { fs.rmSync(path.join(root, stale.name), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function statMtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}
