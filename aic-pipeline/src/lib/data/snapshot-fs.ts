import fs from "fs";
import path from "path";
import type { DisplayFields, SnapshotType, SnapshotRecordPage } from "./types";

function managedDataDir(envsRoot: string, env: string): string {
  return path.join(envsRoot, env, "managed-data");
}

export function listSnapshotTypes(envsRoot: string, env: string): SnapshotType[] {
  const root = managedDataDir(envsRoot, env);
  if (!fs.existsSync(root)) return [];
  const out: SnapshotType[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = path.join(root, entry.name, "_manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      out.push({
        name: entry.name,
        count: typeof m.count === "number" ? m.count : 0,
        pulledAt: typeof m.pulledAt === "number" ? m.pulledAt : 0,
      });
    } catch { /* skip unreadable manifest */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function readRecord(
  envsRoot: string, env: string, type: string, id: string,
): Record<string, unknown> | null {
  const filePath = path.join(managedDataDir(envsRoot, env), type, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function stringOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

interface ListOpts {
  q: string;
  page: number;
  limit: number;
  display: DisplayFields;
  /** Override the display.title field with a user-chosen attribute (e.g. "userName"). */
  titleField?: string;
}

// Match the record key case-insensitively — users configure attributes by
// their natural casing but records may vary.
function findKeyCI(record: Record<string, unknown>, wanted: string): string | undefined {
  const lc = wanted.toLowerCase();
  return Object.keys(record).find((k) => k.toLowerCase() === lc);
}

const FIELD_SAMPLE_SIZE = 20;

export function listRecords(
  envsRoot: string, env: string, type: string, opts: ListOpts,
): SnapshotRecordPage {
  const dir = path.join(managedDataDir(envsRoot, env), type);
  if (!fs.existsSync(dir)) {
    return { total: 0, page: opts.page, limit: opts.limit, records: [], fields: [] };
  }

  const q = opts.q.trim().toLowerCase();
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "_manifest.json")
    .sort();

  // Field union: sample the first N records regardless of search so the
  // display-attribute picker stays populated even when the query matches
  // nothing.
  const fieldSet = new Set<string>();
  for (const f of files.slice(0, FIELD_SAMPLE_SIZE)) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Record<string, unknown>;
      for (const k of Object.keys(record)) fieldSet.add(k);
    } catch { /* skip */ }
  }
  const fields = [...fieldSet].sort();

  const titleField = opts.titleField ?? opts.display.title;
  const start = (opts.page - 1) * opts.limit;

  if (!q) {
    // No search — total is the file count; only read the page slice to
    // extract titles, avoiding thousands of unnecessary file reads.
    const total = files.length;
    const pageFiles = files.slice(start, start + opts.limit);
    const records = pageFiles.map((f) => {
      const id = f.replace(/\.json$/, "");
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Record<string, unknown>;
        const key = findKeyCI(record, titleField);
        const title = (key && stringOrEmpty(record[key])) || id;
        return { id, title };
      } catch {
        return { id, title: id };
      }
    });
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // Search: scan raw text for matches but only parse JSON for the page slice.
  const matchingFiles: string[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      if (raw.toLowerCase().includes(q)) {
        matchingFiles.push(f);
      }
    } catch { /* skip unreadable file */ }
  }

  const total = matchingFiles.length;
  const pageFiles = matchingFiles.slice(start, start + opts.limit);
  const records = pageFiles.map((f) => {
    const id = f.replace(/\.json$/, "");
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Record<string, unknown>;
      const key = findKeyCI(record, titleField);
      const title = (key && stringOrEmpty(record[key])) || id;
      return { id, title };
    } catch {
      return { id, title: id };
    }
  });
  return { total, page: opts.page, limit: opts.limit, fields, records };
}
