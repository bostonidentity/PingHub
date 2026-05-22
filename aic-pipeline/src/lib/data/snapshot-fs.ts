import fs from "fs";
import { existsSync } from "fs";
import fsp from "fs/promises";
import path from "path";
import type Database from "better-sqlite3";
import type { DisplayFields, SnapshotType, SnapshotRecordPage } from "./types";
import { NDJSON_FILE } from "./ndjson-format";
import { openIndexDb } from "./index-db";
import { buildIndexFromNDJson } from "./index-builder";
import { flattenForIndex, attrMatchesPath, collapseArrayIndices } from "./flatten-fields";

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

    let db = openIndexDb(dir);

    // Lazy auto-rebuild: openIndexDb() drops the records table when it detects
    // a stale schemaVersion. If the table is empty but data.ndjson exists,
    // rebuild from the canonical source so callers get a populated index
    // without forcing a tenant re-pull.
    const rowCount = (db.prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c;
    if (rowCount === 0 && existsSync(path.join(dir, NDJSON_FILE))) {
      // Close before rebuild so buildIndexFromNDJson can open its own handle
      // without contention on Windows file locks.
      try { db.close(); } catch { /* ignore */ }
      await buildIndexFromNDJson(dir, flattenForIndex);
      db = openIndexDb(dir);
    }

    // Derive the displayable field list from a sample of fields_json.
    // Flattened paths can include array indices (e.g. `mail.0`, `mail.1`); the
    // UI dropdown collapses those to a single `mail` option since the attr
    // filter matches by prefix.
    const sampleRows = db.prepare(
      "SELECT fields_json FROM records ORDER BY ord LIMIT ?",
    ).all(FIELD_SAMPLE_SIZE) as { fields_json: string }[];
    const fieldSet = new Set<string>();
    for (const row of sampleRows) {
      try {
        for (const k of Object.keys(JSON.parse(row.fields_json) as Record<string, unknown>)) {
          const collapsed = collapseArrayIndices(k);
          if (collapsed) fieldSet.add(collapsed);
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
  /** Restrict matching to this attribute's value (case-insensitive key match). */
  attr?: string;
  /** Comparison operator when `attr` is set. Defaults to "contains". */
  op?: "contains" | "equals" | "startsWith" | "endsWith" | "regex";
  /** When true, operator comparison is case-sensitive. Default false. */
  caseSensitive?: boolean;
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

  // Attribute-scoped filter: when set, ignore the cross-field LIKE path and
  // walk rows applying the operator to that attribute's value(s) only.
  //
  // `attr` is matched against the flattened `fields_json` paths via
  // `attrMatchesPath` (exact / prefix / last-segment, case-insensitive). A
  // record matches if *any* path matching the attr has a value the operator
  // accepts — so attr="mail" tests all `mail.N` elements, attr="givenName"
  // tests every `*.givenName` anywhere in the tree, etc.
  //
  // We use SQLite's iterator so we don't materialize the whole table at once.
  const attrName = opts.attr?.trim();
  if (attrName && opts.q.trim()) {
    const cs = !!opts.caseSensitive;
    const needle = cs ? opts.q : opts.q.toLowerCase();
    const op = opts.op ?? "contains";
    let testFn: (value: string) => boolean;
    if (op === "regex") {
      try {
        const re = new RegExp(opts.q, cs ? "" : "i");
        testFn = (v) => re.test(v);
      } catch {
        // Invalid regex → no matches. UI surfaces an error elsewhere.
        return { total: 0, page: opts.page, limit: opts.limit, records: [], fields };
      }
    } else if (op === "equals") {
      testFn = (v) => (cs ? v : v.toLowerCase()) === needle;
    } else if (op === "startsWith") {
      testFn = (v) => (cs ? v : v.toLowerCase()).startsWith(needle);
    } else if (op === "endsWith") {
      testFn = (v) => (cs ? v : v.toLowerCase()).endsWith(needle);
    } else {
      testFn = (v) => (cs ? v : v.toLowerCase()).includes(needle);
    }
    const iter = db.prepare(
      "SELECT id, fields_json FROM records ORDER BY ord",
    ).iterate() as Iterable<{ id: string; fields_json: string }>;
    const matches: { id: string; fields_json: string }[] = [];
    for (const r of iter) {
      let f: Record<string, string>;
      try { f = JSON.parse(r.fields_json) as Record<string, string>; }
      catch { continue; }
      let matched = false;
      for (const key of Object.keys(f)) {
        if (!attrMatchesPath(attrName, key)) continue;
        if (testFn(String(f[key] ?? ""))) { matched = true; break; }
      }
      if (matched) matches.push(r);
    }
    const total = matches.length;
    const pageRows = matches.slice(start, start + opts.limit);
    const records = pageRows.map((r) => {
      const f = JSON.parse(r.fields_json) as Record<string, string>;
      const key = findKeyCI(f, titleField);
      const title = (key && f[key]) || r.id;
      return { id: r.id, title };
    });
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

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


export interface TitleRef { type: string; id: string }
export interface ResolveTitlesResult {
  /** key = `${type}/${id}`. null = type not pulled OR id not in that type's index. */
  titles: Record<string, string | null>;
  /** Sorted scalar fields per referenced type. [] when the type isn't pulled. */
  fieldsByType: Record<string, string[]>;
}

/**
 * Resolve a list of (type, id) refs to display titles using the chosen
 * attribute per type. Looks up `fields_json` from each type's SQLite index
 * (no NDJSON read), picks the attr case-insensitively, falls back to id.
 *
 * Used by the data tab's deps panel so users can label dependencies the
 * same way as the left-panel record list.
 */
export async function resolveTitles(
  envsRoot: string,
  env: string,
  refs: TitleRef[],
  attrs: Record<string, string>,
): Promise<ResolveTitlesResult> {
  const titles: Record<string, string | null> = {};
  const fieldsByType: Record<string, string[]> = {};
  if (refs.length === 0) return { titles, fieldsByType };

  // Group refs by type to issue one SQLite session per type.
  const byType = new Map<string, string[]>();
  for (const r of refs) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r.id);
  }

  for (const [type, ids] of byType.entries()) {
    const dir = path.join(managedDataDir(envsRoot, env), type);
    if (!existsSync(dir)) {
      fieldsByType[type] = [];
      for (const id of ids) titles[`${type}/${id}`] = null;
      continue;
    }
    const tc = await loadCache(dir);
    fieldsByType[type] = tc.fields;
    const attrWanted = attrs[type] ?? "";
    const stmt = tc.db.prepare("SELECT fields_json FROM records WHERE id = ?");
    for (const id of ids) {
      const row = stmt.get(id) as { fields_json: string } | undefined;
      if (!row) { titles[`${type}/${id}`] = null; continue; }
      if (!attrWanted) { titles[`${type}/${id}`] = id; continue; }
      try {
        const f = JSON.parse(row.fields_json) as Record<string, string>;
        const key = findKeyCI(f, attrWanted);
        const val = key ? f[key] : "";
        titles[`${type}/${id}`] = val || id;
      } catch {
        titles[`${type}/${id}`] = id;
      }
    }
  }

  return { titles, fieldsByType };
}

/** Evict the cache for a specific type directory. Exposed for testing. */
export function evictCache(dir: string): void {
  const entry = cache.get(dir);
  if (entry) {
    try { entry.db.close(); } catch { /* ignore */ }
    cache.delete(dir);
  }
}
