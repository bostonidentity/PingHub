import path from "path";
import Database from "better-sqlite3";

export const INDEX_DB_FILE = "index.sqlite";
/**
 * Bump when the on-disk index shape changes in a way that requires a rebuild.
 *
 * v1 → v2 (May 2026):
 *   fields_json now stores a deep-flattened map of dotted-path → string value
 *   (previously: only top-level scalars). This is what powers the per-attribute
 *   search over nested objects, arrays, and `_ref` relationships. v1 indices
 *   are wiped on open; the caller (snapshot-fs) lazy-rebuilds from data.ndjson.
 *
 * v2 → v3 (May 2026):
 *   The v2 openIndexDb had a bug: when upgrading a v1 DB (which had no `meta`
 *   table), the stale-schema check returned `undefined` and `INSERT OR IGNORE`
 *   silently stamped schemaVersion=2 on top of the v1 records. Those tenants
 *   ended up with a v2 stamp on v1 data and searches still missed nested
 *   values. Bumping to v3 (combined with the fixed v1-detection path) forces
 *   one final rebuild for everyone.
 *
 * v3 → v4 (May 2026):
 *   Per-leaf string cap raised from 200 to 10 000 chars. Real-world content
 *   like dashboard widget descriptions and translated UI copy regularly
 *   exceeds 200 chars, so the v3 index silently dropped them and the
 *   attribute filter found nothing. Forcing a rebuild repopulates fields_json
 *   with those values.
 */
export const SCHEMA_VERSION = 4;

/**
 * Open (or create) the per-type index DB for `typeDir`.
 *
 * Schema:
 *   records(id PK, ord, offset, length, fields_json, searchable)
 *     - id:           record _id
 *     - ord:          0-based pull order (matches NDJSON line order)
 *     - offset:       byte offset of the record line in data.ndjson
 *     - length:       byte length of the line excluding the trailing newline
 *     - fields_json:  JSON-stringified flattened {path → value} map
 *     - searchable:   lowercased concatenation of leaf values, used for LIKE '%q%' search
 *   meta(key PK, value)
 *     - schemaVersion: SCHEMA_VERSION
 *     - pulledAt:      manifest pulledAt mirror (set after a successful pull)
 *
 * WAL mode + synchronous=NORMAL — durability is unnecessary because the DB is
 * a derived index that can be rebuilt from data.ndjson at any time.
 *
 * If a pre-existing DB declares a stale schemaVersion (or none), the records
 * table is dropped so the caller can rebuild from data.ndjson. The DB file
 * itself is retained to preserve WAL/SHM handles already open elsewhere.
 */
export function openIndexDb(typeDir: string): Database.Database {
  const dbPath = path.join(typeDir, INDEX_DB_FILE);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.prepare(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run();

  // Detect a stale schema BEFORE creating the records table so we can wipe it.
  // Two stale cases:
  //   1. meta.schemaVersion exists and differs from SCHEMA_VERSION.
  //   2. A `records` table already exists but meta.schemaVersion is missing —
  //      this is a v1 index (the meta table was introduced in v2). The records
  //      table was just created above as empty if it didn't exist, so we have
  //      to probe sqlite_master directly rather than relying on a row count.
  const recordsExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'",
  ).get() !== undefined;
  const existing = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
    { value: string } | undefined;
  const stale =
    (existing && existing.value !== String(SCHEMA_VERSION)) ||
    (recordsExists && !existing);
  if (stale) {
    db.prepare("DROP TABLE IF EXISTS records").run();
    db.prepare(
      "INSERT INTO meta(key,value) VALUES ('schemaVersion', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
  }

  db.prepare(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY NOT NULL,
      ord INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      length INTEGER NOT NULL,
      fields_json TEXT NOT NULL,
      searchable TEXT NOT NULL
    )
  `).run();
  db.prepare("CREATE INDEX IF NOT EXISTS records_ord ON records(ord)").run();
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
  return db;
}
