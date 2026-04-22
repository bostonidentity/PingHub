import { existsSync } from "fs";
import fsp from "fs/promises";
import path from "path";
import type { DisplayFields, SnapshotType, SnapshotRecordPage } from "./types";

function managedDataDir(envsRoot: string, env: string): string {
  return path.join(envsRoot, env, "managed-data");
}

// ── Index types ────────────────────────────────────────────────────────────

/** One entry in the _index.json written at pull time. */
interface IndexEntry {
  id: string;
  /** Short scalar fields extracted from the record. */
  f: Record<string, string>;
}

// ── In-memory cache ────────────────────────────────────────────────────────
// Keyed by `<dir>` and invalidated when the manifest `pulledAt` changes, so
// new pulls automatically bust the cache.

interface TypeCache {
  pulledAt: number;
  /** All record filenames (sorted, excluding _ prefixed). */
  files: string[];
  /** Union of top-level keys from the index or a sample. */
  fields: string[];
  /** Full index when _index.json is available, else null. */
  index: IndexEntry[] | null;
}

const cache = new Map<string, TypeCache>();

// In-flight cache loads — prevents duplicate readdir work when multiple
// requests arrive for the same cold type simultaneously.
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

  // Coalesce concurrent requests for the same cold directory.
  const inflight = pending.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    const files = (await fsp.readdir(dir))
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .sort();

    // Try to load the index built at pull time.
    let index: IndexEntry[] | null = null;
    const indexPath = path.join(dir, "_index.json");
    if (existsSync(indexPath)) {
      try {
        index = JSON.parse(await fsp.readFile(indexPath, "utf-8")) as IndexEntry[];
      } catch { /* fall back to file reads */ }
    }

    // Derive fields from the index (every scalar field seen). If no index,
    // sample a few files like before.
    const fieldSet = new Set<string>();
    if (index) {
      for (const entry of index.slice(0, FIELD_SAMPLE_SIZE)) {
        for (const k of Object.keys(entry.f)) fieldSet.add(k);
      }
    } else {
      for (const f of files.slice(0, FIELD_SAMPLE_SIZE)) {
        try {
          const record = JSON.parse(await fsp.readFile(path.join(dir, f), "utf-8")) as Record<string, unknown>;
          for (const k of Object.keys(record)) fieldSet.add(k);
        } catch { /* skip */ }
      }
    }

    const entry: TypeCache = { pulledAt, files, fields: [...fieldSet].sort(), index };
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
  const filePath = path.join(managedDataDir(envsRoot, env), type, `${id}.json`);
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
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

export async function listRecords(
  envsRoot: string, env: string, type: string, opts: ListOpts,
): Promise<SnapshotRecordPage> {
  const dir = path.join(managedDataDir(envsRoot, env), type);
  if (!existsSync(dir)) {
    return { total: 0, page: opts.page, limit: opts.limit, records: [], fields: [] };
  }

  const q = opts.q.trim().toLowerCase();
  const tc = await loadCache(dir);
  const { files, fields, index } = tc;
  const titleField = opts.titleField ?? opts.display.title;
  const start = (opts.page - 1) * opts.limit;

  if (!q) {
    // No search — use the cached file list + index for O(1) pagination.
    const total = files.length;
    const pageFiles = files.slice(start, start + opts.limit);

    if (index) {
      // Fast path: look up titles from the in-memory index.
      const byId = new Map<string, IndexEntry>();
      for (const e of index) byId.set(e.id, e);
      const records = pageFiles.map((f) => {
        const id = f.replace(/\.json$/, "");
        const entry = byId.get(id);
        if (entry) {
          const key = findKeyCI(entry.f, titleField);
          const title = (key && entry.f[key]) || id;
          return { id, title };
        }
        return { id, title: id };
      });
      return { total, page: opts.page, limit: opts.limit, fields, records };
    }

    // No index — read only the page slice files (legacy data).
    const records = await Promise.all(pageFiles.map((f) => {
      const id = f.replace(/\.json$/, "");
      return readTitleFromFile(dir, f, id, titleField);
    }));
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // Search path.
  if (index) {
    // Fast search: scan the in-memory index fields for matches, avoiding
    // file I/O entirely for the common case where the query hits indexed fields.
    const matchingEntries: IndexEntry[] = [];
    for (const entry of index) {
      for (const v of Object.values(entry.f)) {
        if (v.toLowerCase().includes(q)) {
          matchingEntries.push(entry);
          break;
        }
      }
    }
    const total = matchingEntries.length;
    const pageEntries = matchingEntries.slice(start, start + opts.limit);
    const records = pageEntries.map((entry) => {
      const key = findKeyCI(entry.f, titleField);
      const title = (key && entry.f[key]) || entry.id;
      return { id: entry.id, title };
    });
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // No index — fall back to scanning raw files.
  const matchingFiles: string[] = [];
  for (const f of files) {
    try {
      const raw = await fsp.readFile(path.join(dir, f), "utf-8");
      if (raw.toLowerCase().includes(q)) {
        matchingFiles.push(f);
      }
    } catch { /* skip unreadable file */ }
  }

  const total = matchingFiles.length;
  const pageFiles = matchingFiles.slice(start, start + opts.limit);
  const records = await Promise.all(pageFiles.map((f) => {
    const id = f.replace(/\.json$/, "");
    return readTitleFromFile(dir, f, id, titleField);
  }));
  return { total, page: opts.page, limit: opts.limit, fields, records };
}

/** Read a single file to extract its title — fallback for legacy (pre-index) data. */
async function readTitleFromFile(
  dir: string, filename: string, id: string, titleField: string,
): Promise<{ id: string; title: string }> {
  try {
    const record = JSON.parse(await fsp.readFile(path.join(dir, filename), "utf-8")) as Record<string, unknown>;
    const key = findKeyCI(record, titleField);
    const title = (key && stringOrEmpty(record[key])) || id;
    return { id, title };
  } catch {
    return { id, title: id };
  }
}

/** Evict the cache for a specific type directory. Exposed for testing. */
export function evictCache(dir: string): void {
  cache.delete(dir);
}
