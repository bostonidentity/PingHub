import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { CompareEndpoint } from "./diff-types";
import { loadSettings, resolveTargetDir, targetHasGit } from "./git-settings";

const REPO_ROOT = process.cwd();
const ENVIRONMENTS_DIR = path.join(REPO_ROOT, "environments");
const OP_LOG_PATH = path.join(ENVIRONMENTS_DIR, ".op-log.jsonl");
const OP_LOG_MAX = 500;
const REPORTS_DIR = path.join(ENVIRONMENTS_DIR, "promotion-reports");

export type OpType = "pull" | "push" | "compare" | "dry-run" | "promote" | "log-search" | "analyze";
export type OpStatus = "success" | "failed";

// ── Types ────────────────────────────────────────────────────────────────────

/** Metadata embedded as git commit trailers for operations that produce commits (pull). */
export interface OpMetadata {
  operation: OpType;
  environment: string;
  scopes?: string[];
  status?: OpStatus;
  startedAt?: string;
  durationMs?: number;
  added?: number;
  modified?: number;
  deleted?: number;
  source?: string;
  target?: string;
  taskId?: string;
  taskName?: string;
}

export interface DiffCounts {
  added: number;
  modified: number;
  removed: number;
}

export interface PromoteDiffTotals extends DiffCounts {
  /** Per-scope breakdown derived from the dry-run compare report. */
  perScope?: Record<string, DiffCounts>;
}

export interface PromoteItem {
  scope: string;
  /** undefined = "all items in scope"; string[] = the explicit item identifiers selected. */
  items?: string[];
}

export interface PhaseTiming {
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/** Unified history record — same shape whether backed by a git commit or an op-log entry. */
export interface HistoryRecord {
  id: string;
  kind: "commit" | "op";
  type: OpType;
  environment: string;
  scopes: string[];
  status: OpStatus;
  commitHash: string | null;
  startedAt: string;
  completedAt: string;
  duration: number;
  summary: string;
  source?: CompareEndpoint;
  target?: CompareEndpoint;
  author?: string;
  taskId?: string;
  taskName?: string;
  phaseOutcomes?: Record<string, string>;
  logSource?: string;
  logMode?: string;
  logPreset?: string;
  logEntryCount?: number;
  // ── Promote enrichments ──
  items?: PromoteItem[];
  diffTotals?: PromoteDiffTotals;
  phaseTimings?: Record<string, PhaseTiming>;
  /** ID of a saved CompareReport file in promotion-reports/ (promote ops only). */
  reportId?: string;
  /** Repo HEAD captured at the moment the record was appended. */
  repoCommit?: string;
}

/** Input shape for appendOpLog — same as HistoryRecord minus computed fields. */
export interface OpLogInput {
  type: OpType;
  environment: string;
  scopes: string[];
  status: OpStatus;
  startedAt: string;
  durationMs: number;
  summary: string;
  source?: CompareEndpoint;
  target?: CompareEndpoint;
  taskId?: string;
  taskName?: string;
  phaseOutcomes?: Record<string, string>;
  logSource?: string;
  logMode?: string;
  logPreset?: string;
  logEntryCount?: number;
  items?: PromoteItem[];
  diffTotals?: PromoteDiffTotals;
  phaseTimings?: Record<string, PhaseTiming>;
  reportId?: string;
}

// ── Git root resolution ──────────────────────────────────────────────────────

/** Resolve the directory containing the authoritative git repo for history. */
export function getHistoryGitRoot(): string | null {
  try {
    const settings = loadSettings();
    if (targetHasGit(settings)) return resolveTargetDir(settings);
  } catch {
    /* settings may not exist yet */
  }
  return null;
}

// ── Commit trailers ──────────────────────────────────────────────────────────

export function buildTrailers(meta: OpMetadata): string {
  const lines: string[] = [];
  lines.push(`Operation: ${meta.operation}`);
  lines.push(`Environment: ${meta.environment}`);
  if (meta.scopes?.length) lines.push(`Scopes: ${meta.scopes.join(",")}`);
  if (meta.status) lines.push(`Status: ${meta.status}`);
  if (meta.startedAt) lines.push(`Started-At: ${meta.startedAt}`);
  if (meta.durationMs != null) lines.push(`Duration-ms: ${meta.durationMs}`);
  if (meta.added != null || meta.modified != null || meta.deleted != null) {
    lines.push(`Changed: +${meta.added ?? 0} ~${meta.modified ?? 0} -${meta.deleted ?? 0}`);
  }
  if (meta.source) lines.push(`Source: ${meta.source}`);
  if (meta.target) lines.push(`Target: ${meta.target}`);
  if (meta.taskId) lines.push(`Task-Id: ${meta.taskId}`);
  if (meta.taskName) lines.push(`Task-Name: ${meta.taskName}`);
  return lines.join("\n");
}

function parseTrailers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) return out;
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ── Commit history (git log reader) ──────────────────────────────────────────

const COMMIT_SEP = "\x1e";
const FIELD_SEP = "\x1f";

interface CommitFilter {
  environment?: string;
  type?: OpType;
  limit?: number;
}

export function readCommitHistory(opts?: CommitFilter): HistoryRecord[] {
  const cwd = getHistoryGitRoot();
  if (!cwd) return [];

  const limit = opts?.limit ?? 500;
  const format = ["%H", "%h", "%an", "%at", "%s", "%b"].join(FIELD_SEP) + COMMIT_SEP;
  let output: string;
  try {
    output = execSync(`git log -n ${limit} --pretty=format:${JSON.stringify(format)}`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const entries: HistoryRecord[] = [];
  for (const raw of output.split(COMMIT_SEP)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(FIELD_SEP);
    const [hash, shortHash, author, atStr, subject, body] = parts;
    const atNum = Number(atStr);
    if (!atStr || isNaN(atNum)) continue;
    const commitDate = new Date(atNum * 1000).toISOString();
    const trailers = parseTrailers(body ?? "");

    if (trailers.Operation) {
      const startedAt = trailers["Started-At"] ?? commitDate;
      const duration = Number(trailers["Duration-ms"] ?? 0);
      entries.push({
        id: hash,
        kind: "commit",
        type: (trailers.Operation as OpType) ?? "pull",
        environment: trailers.Environment ?? "",
        scopes: trailers.Scopes ? trailers.Scopes.split(",").filter(Boolean) : [],
        status: (trailers.Status as OpStatus) ?? "success",
        commitHash: shortHash,
        startedAt,
        completedAt: commitDate,
        duration,
        summary: subject ?? "",
        author,
        taskId: trailers["Task-Id"],
        taskName: trailers["Task-Name"],
      });
    } else {
      // Legacy commit with no trailers — parse the subject best-effort
      const match = subject?.match(/^(pull|push|promote|compare)\(([^)]+)\):?\s*(.*)$/i);
      const type = (match?.[1]?.toLowerCase() as OpType | undefined) ?? "pull";
      const environment = match?.[2] ?? "";
      entries.push({
        id: hash,
        kind: "commit",
        type,
        environment,
        scopes: [],
        status: "success",
        commitHash: shortHash,
        startedAt: commitDate,
        completedAt: commitDate,
        duration: 0,
        summary: subject ?? "",
        author,
      });
    }
  }

  return filterRecords(entries, opts);
}

function filterRecords(entries: HistoryRecord[], opts?: CommitFilter): HistoryRecord[] {
  let out = entries;
  if (opts?.environment) {
    const env = opts.environment;
    out = out.filter(
      (e) => e.environment === env || e.source?.environment === env || e.target?.environment === env,
    );
  }
  if (opts?.type) out = out.filter((e) => e.type === opts.type);
  return out;
}

// ── Op log (JSONL) ───────────────────────────────────────────────────────────

function readRepoHead(): string | undefined {
  try {
    const root = getHistoryGitRoot();
    if (!root) return undefined;
    return runShell("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

const runShell = execSync;

export function appendOpLog(input: OpLogInput): HistoryRecord {
  const id = crypto.randomUUID();
  const now = Date.now();
  const record: HistoryRecord = {
    id,
    kind: "op",
    type: input.type,
    environment: input.environment,
    scopes: input.scopes,
    status: input.status,
    commitHash: null,
    startedAt: input.startedAt,
    completedAt: new Date(now).toISOString(),
    duration: input.durationMs,
    summary: input.summary,
    source: input.source,
    target: input.target,
    taskId: input.taskId,
    taskName: input.taskName,
    phaseOutcomes: input.phaseOutcomes,
    logSource: input.logSource,
    logMode: input.logMode,
    logPreset: input.logPreset,
    logEntryCount: input.logEntryCount,
    items: input.items,
    diffTotals: input.diffTotals,
    phaseTimings: input.phaseTimings,
    reportId: input.reportId,
    repoCommit: readRepoHead(),
  };

  try {
    if (!fs.existsSync(ENVIRONMENTS_DIR)) fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
    fs.appendFileSync(OP_LOG_PATH, JSON.stringify(record) + "\n");
    rotateOpLog();
  } catch {
    /* non-fatal */
  }
  return record;
}

function rotateOpLog(): void {
  try {
    if (!fs.existsSync(OP_LOG_PATH)) return;
    const raw = fs.readFileSync(OP_LOG_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length <= OP_LOG_MAX) return;
    const trimmed = lines.slice(-OP_LOG_MAX);
    fs.writeFileSync(OP_LOG_PATH, trimmed.join("\n") + "\n");
  } catch {
    /* ignore */
  }
}

export function readOpLog(opts?: CommitFilter): HistoryRecord[] {
  if (!fs.existsSync(OP_LOG_PATH)) return [];
  try {
    const raw = fs.readFileSync(OP_LOG_PATH, "utf-8");
    const records: HistoryRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as HistoryRecord);
      } catch {
        /* skip malformed */
      }
    }
    records.reverse();
    return filterRecords(records, opts);
  } catch {
    return [];
  }
}

// ── Merged feed ──────────────────────────────────────────────────────────────

export function readHistoryMerged(opts?: CommitFilter): HistoryRecord[] {
  const commits = readCommitHistory(opts);
  const ops = readOpLog(opts);

  // Deduplicate: if an op-log entry has a matching commit (same type, environment,
  // and startedAt within 2 seconds), prefer the commit (richer metadata).
  const commitKeys = new Set(
    commits.map((c) => `${c.type}|${c.environment}|${c.startedAt.slice(0, 19)}`),
  );
  const dedupedOps = ops.filter((o) => {
    const key = `${o.type}|${o.environment}|${o.startedAt.slice(0, 19)}`;
    return !commitKeys.has(key);
  });

  const merged = [...commits, ...dedupedOps].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  return opts?.limit ? merged.slice(0, opts.limit) : merged;
}

export function readHistoryEntry(id: string): HistoryRecord | null {
  const ops = readOpLog();
  const op = ops.find((r) => r.id === id);
  if (op) return op;
  const commits = readCommitHistory({ limit: 2000 });
  return commits.find((c) => c.id === id || c.commitHash === id) ?? null;
}

// ── Promotion reports (CompareReport JSON files) ────────────────────────────

/** Save a CompareReport JSON for a promotion record. Returns the report ID. */
export function savePromotionReport(reportId: string, report: unknown): void {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `${reportId}.json`), JSON.stringify(report));
}

/** Load a saved CompareReport by ID. Returns null if not found. */
export function loadPromotionReport(reportId: string): unknown | null {
  const fp = path.join(REPORTS_DIR, `${reportId}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}
