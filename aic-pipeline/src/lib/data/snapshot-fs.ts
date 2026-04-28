import fs from "fs";
import { existsSync } from "fs";
import fsp from "fs/promises";
import readline from "readline";
import path from "path";
import type { DisplayFields, SnapshotType, SnapshotRecordPage } from "./types";
import { isNDJsonFormat, NDJSON_FILE, OFFSETS_FILE, type Offsets } from "./ndjson-format";

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
  /** All record ids in deterministic order (sorted by id for legacy parity). */
  ids: string[];
  /** Union of top-level keys from the index or a sample. */
  fields: string[];
  /** Full index when _index.json is available, else null. */
  index: IndexEntry[] | null;
  /** True when the directory uses NDJSON storage. */
  ndjson: boolean;
  /** Offsets map for NDJSON format; null otherwise. */
  offsets: Offsets | null;
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

  const inflight = pending.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    const ndjson = isNDJsonFormat(dir);

    // Try to load the index built at pull time.
    let index: IndexEntry[] | null = null;
    const indexPath = path.join(dir, "_index.json");
    if (existsSync(indexPath)) {
      try {
        index = JSON.parse(await fsp.readFile(indexPath, "utf-8")) as IndexEntry[];
      } catch { /* fall back to file reads / NDJSON streaming */ }
    }

    let offsets: Offsets | null = null;
    let ids: string[];

    if (ndjson) {
      try {
        offsets = JSON.parse(await fsp.readFile(path.join(dir, OFFSETS_FILE), "utf-8")) as Offsets;
      } catch { offsets = {}; }
      // Use index order if available (matches pull order); else sort offset keys.
      ids = index ? index.map((e) => e.id) : Object.keys(offsets).sort();
    } else {
      const files = (await fsp.readdir(dir))
        .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
        .sort();
      ids = files.map((f) => f.replace(/\.json$/, ""));
    }

    // Derive fields.
    const fieldSet = new Set<string>();
    if (index) {
      for (const entry of index.slice(0, FIELD_SAMPLE_SIZE)) {
        for (const k of Object.keys(entry.f)) fieldSet.add(k);
      }
    } else if (ndjson) {
      // Sample the first FIELD_SAMPLE_SIZE lines of data.ndjson.
      try {
        const stream = fs.createReadStream(path.join(dir, NDJSON_FILE), { encoding: "utf-8" });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let n = 0;
        for await (const line of rl) {
          if (!line) continue;
          try {
            const r = JSON.parse(line) as Record<string, unknown>;
            for (const k of Object.keys(r)) fieldSet.add(k);
          } catch { /* skip */ }
          if (++n >= FIELD_SAMPLE_SIZE) break;
        }
        rl.close();
        stream.destroy();
      } catch { /* skip */ }
    } else {
      // Legacy per-record sample.
      for (const id of ids.slice(0, FIELD_SAMPLE_SIZE)) {
        try {
          const record = JSON.parse(
            await fsp.readFile(path.join(dir, `${id}.json`), "utf-8"),
          ) as Record<string, unknown>;
          for (const k of Object.keys(record)) fieldSet.add(k);
        } catch { /* skip */ }
      }
    }

    const entry: TypeCache = {
      pulledAt, ids, fields: [...fieldSet].sort(), index, ndjson, offsets,
    };
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

  if (isNDJsonFormat(typeDir)) {
    return readRecordFromNDJson(typeDir, id);
  }

  // Legacy {id}.json path.
  const filePath = path.join(typeDir, `${id}.json`);
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function readRecordFromNDJson(
  typeDir: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const offsetsPath = path.join(typeDir, OFFSETS_FILE);
  let offsets: Offsets;
  try {
    offsets = JSON.parse(await fsp.readFile(offsetsPath, "utf-8")) as Offsets;
  } catch { return null; }

  const off = offsets[id];
  if (typeof off !== "number") return null;

  const ndjsonPath = path.join(typeDir, NDJSON_FILE);
  const fd = await fsp.open(ndjsonPath, "r");
  try {
    // Read a chunk starting at the offset; expand if we don't see a newline.
    const initialChunk = 8192;
    let buf = Buffer.alloc(initialChunk);
    let { bytesRead } = await fd.read(buf, 0, initialChunk, off);
    let lineEnd = buf.indexOf(0x0a /* \n */, 0);
    while (lineEnd === -1 && bytesRead === buf.length) {
      const next = Buffer.alloc(buf.length * 2);
      buf.copy(next, 0, 0, bytesRead);
      const r = await fd.read(next, bytesRead, next.length - bytesRead, off + bytesRead);
      bytesRead += r.bytesRead;
      buf = next;
      lineEnd = buf.indexOf(0x0a, 0);
      if (r.bytesRead === 0) break;
    }
    const line = buf.slice(0, lineEnd === -1 ? bytesRead : lineEnd).toString("utf-8");
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { return null; }
  } finally {
    await fd.close();
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
  const { ids, fields, index, ndjson } = tc;
  const titleField = opts.titleField ?? opts.display.title;
  const start = (opts.page - 1) * opts.limit;

  if (!q) {
    // No search — paginate over ids.
    const total = ids.length;
    const pageIds = ids.slice(start, start + opts.limit);

    if (index) {
      const byId = new Map<string, IndexEntry>();
      for (const e of index) byId.set(e.id, e);
      const records = pageIds.map((id) => {
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

    // No index — read titles per page (legacy) or stream-skip via NDJSON.
    if (ndjson) {
      const records = await readTitlesFromNDJson(dir, pageIds, titleField);
      return { total, page: opts.page, limit: opts.limit, fields, records };
    }
    const records = await Promise.all(pageIds.map((id) => {
      return readTitleFromFile(dir, `${id}.json`, id, titleField);
    }));
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // Search path.
  if (index) {
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

  // No index — stream-search NDJSON or scan per-record files.
  if (ndjson) {
    const matching: { id: string; title: string }[] = [];
    const stream = fs.createReadStream(path.join(dir, NDJSON_FILE), { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      if (!line.toLowerCase().includes(q)) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        const id = typeof r._id === "string" ? r._id : "";
        if (!id) continue;
        const key = findKeyCI(r, titleField);
        const title = key ? stringOrEmpty(r[key]) || id : id;
        matching.push({ id, title });
      } catch { /* skip */ }
    }
    rl.close();
    stream.destroy();
    const total = matching.length;
    const records = matching.slice(start, start + opts.limit);
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // Legacy per-record fallback.
  const matchingIds: string[] = [];
  for (const id of ids) {
    try {
      const raw = await fsp.readFile(path.join(dir, `${id}.json`), "utf-8");
      if (raw.toLowerCase().includes(q)) {
        matchingIds.push(id);
      }
    } catch { /* skip */ }
  }
  const total = matchingIds.length;
  const pageIds = matchingIds.slice(start, start + opts.limit);
  const records = await Promise.all(pageIds.map((id) =>
    readTitleFromFile(dir, `${id}.json`, id, titleField),
  ));
  return { total, page: opts.page, limit: opts.limit, fields, records };
}

async function readTitlesFromNDJson(
  dir: string,
  wantedIds: string[],
  titleField: string,
): Promise<{ id: string; title: string }[]> {
  const wanted = new Set(wantedIds);
  const found = new Map<string, string>();
  const stream = fs.createReadStream(path.join(dir, NDJSON_FILE), { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const id = typeof r._id === "string" ? r._id : "";
      if (!id || !wanted.has(id)) continue;
      const key = findKeyCI(r, titleField);
      found.set(id, key ? stringOrEmpty(r[key]) || id : id);
      if (found.size === wanted.size) break;
    } catch { /* skip */ }
  }
  rl.close();
  stream.destroy();
  return wantedIds.map((id) => ({ id, title: found.get(id) ?? id }));
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
