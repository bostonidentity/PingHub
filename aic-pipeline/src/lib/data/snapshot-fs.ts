import fs from "fs";
import { existsSync } from "fs";
import fsp from "fs/promises";
import path from "path";
import type Database from "better-sqlite3";
import type { DisplayFields, SnapshotType, SnapshotRecordPage } from "./types";
import { NDJSON_FILE } from "./ndjson-format";
import { openIndexDb } from "./index-db";

function managedDataDir(envsRoot: string, env: string): string {
  return path.join(envsRoot, env, "managed-data");
}

/**
 * Per-directory cached SQLite handle. Key = typeDir. Invalidated when the
 * manifest's `pulledAt` differs from `pulledAt` recorded here at open time —
 * a new pull writes a new `index.sqlite` plus a new `_manifest.json`.
 */
interface TypeCache {
  pulledAt: number;
  /** Open `index.sqlite` connection. */
  db: Database.Database;
  /** Indexed scalar field names — derived once from a single SQLite query. */
  fields: string[];
}

const cache = new Map<string, TypeCache>();
const pending = new Map<string, Promise<TypeCache>>();

async function getManifestPulledAt(dir: string): Promise<number> {
  try {
    const m = JSON.parse(await fsp.readFile(path.join(dir, "_manifest.json"), "utf-8"));
    return typeof m.pulledAt === "number" ? m.pulledAt : 0;
  } catch { return 0; }
}

async function loadCache(dir: string): Promise<TypeCache> {
  const pulledAt = await getManifestPulledAt(dir);
  const existing = cache.get(dir);
  if (existing && existing.pulledAt === pulledAt) return existing;

  const inflight = pending.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    if (existing) {
      try { existing.db.close(); } catch { /* ignore */ }
      cache.delete(dir);
    }

    const db = openIndexDb(dir);
    // Derive field list from a sample of fields_json — same shape as before.
    const sampleRows = db.prepare(
      "SELECT fields_json FROM records ORDER BY ord LIMIT ?",
    ).all(FIELD_SAMPLE_SIZE) as { fields_json: string }[];
    const fieldSet = new Set<string>();
    for (const row of sampleRows) {
      try {
        for (const k of Object.keys(JSON.parse(row.fields_json) as Record<string, unknown>)) {
          fieldSet.add(k);
        }
      } catch { /* skip malformed */ }
    }
    const entry: TypeCache = { pulledAt, db, fields: [...fieldSet].sort() };
    cache.set(dir, entry);
    return entry;
  })();

  pending.set(dir, work);
  try { return await work; } finally { pending.delete(dir); }
}

export async function listSnapshotTypes(envsRoot: string, env: string): Promise<SnapshotType[]> {
  const root = managedDataDir(envsRoot, env);
  if (!existsSync(root)) return [];
  const out: SnapshotType[] = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = path.join(root, entry.name, "_manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));
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

export async function readRecord(
  envsRoot: string, env: string, type: string, id: string,
): Promise<Record<string, unknown> | null> {
  const typeDir = path.join(managedDataDir(envsRoot, env), type);
  return readRecordFromNDJson(typeDir, id);
}

async function readRecordFromNDJson(
  typeDir: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const tc = await loadCache(typeDir);
  const row = tc.db.prepare(
    "SELECT offset, length FROM records WHERE id = ?",
  ).get(id) as { offset: number; length: number } | undefined;
  if (!row) return null;

  const ndjsonPath = path.join(typeDir, NDJSON_FILE);
  const fd = await fsp.open(ndjsonPath, "r");
  try {
    const buf = Buffer.alloc(row.length);
    await fd.read(buf, 0, row.length, row.offset);
    try { return JSON.parse(buf.toString("utf-8")) as Record<string, unknown>; }
    catch { return null; }
  } finally {
    await fd.close();
  }
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

export async function listRecords(
  envsRoot: string, env: string, type: string, opts: ListOpts,
): Promise<SnapshotRecordPage> {
  const dir = path.join(managedDataDir(envsRoot, env), type);
  if (!existsSync(dir)) {
    return { total: 0, page: opts.page, limit: opts.limit, records: [], fields: [] };
  }

  const q = opts.q.trim().toLowerCase();
  const tc = await loadCache(dir);
  const { db, fields } = tc;
  const titleField = opts.titleField ?? opts.display.title;
  const start = (opts.page - 1) * opts.limit;

  if (!q) {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c;
    const rows = db.prepare(
      "SELECT id, fields_json FROM records ORDER BY ord LIMIT ? OFFSET ?",
    ).all(opts.limit, start) as { id: string; fields_json: string }[];
    const records = rows.map((r) => {
      const f = JSON.parse(r.fields_json) as Record<string, string>;
      const key = findKeyCI(f, titleField);
      const title = (key && f[key]) || r.id;
      return { id: r.id, title };
    });
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // Search path — substring LIKE on the precomputed lowercased `searchable`
  // column. Same semantics as the legacy String.includes() comparison.
  const like = `%${q.replace(/[\\_%]/g, (c) => `\\${c}`)}%`;
  const total = (db.prepare(
    "SELECT COUNT(*) AS c FROM records WHERE searchable LIKE ? ESCAPE '\\'",
  ).get(like) as { c: number }).c;
  const rows = db.prepare(
    "SELECT id, fields_json FROM records WHERE searchable LIKE ? ESCAPE '\\' ORDER BY ord LIMIT ? OFFSET ?",
  ).all(like, opts.limit, start) as { id: string; fields_json: string }[];
  const records = rows.map((r) => {
    const f = JSON.parse(r.fields_json) as Record<string, string>;
    const key = findKeyCI(f, titleField);
    const title = (key && f[key]) || r.id;
    return { id: r.id, title };
  });
  return { total, page: opts.page, limit: opts.limit, fields, records };
}


/** Evict the cache for a specific type directory. Exposed for testing. */
export function evictCache(dir: string): void {
  const entry = cache.get(dir);
  if (entry) {
    try { entry.db.close(); } catch { /* ignore */ }
    cache.delete(dir);
  }
}
