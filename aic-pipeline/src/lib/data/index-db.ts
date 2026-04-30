import path from "path";
import Database from "better-sqlite3";

export const INDEX_DB_FILE = "index.sqlite";
export const SCHEMA_VERSION = 1;

/**
 * Open (or create) the per-type index DB for `typeDir`.
 *
 * Schema (v1):
 *   records(id PK, ord, offset, length, fields_json, searchable)
 *     - id:           record _id
 *     - ord:          0-based pull order (matches NDJSON line order)
 *     - offset:       byte offset of the record line in data.ndjson
 *     - length:       byte length of the line excluding the trailing newline
 *     - fields_json:  JSON-stringified scalar field map (== legacy _index.json's `f`)
 *     - searchable:   lowercased concatenation of scalar field values, used for LIKE '%q%' search
 *   meta(key PK, value)
 *     - schemaVersion: SCHEMA_VERSION
 *     - pulledAt:      manifest pulledAt mirror (set after a successful pull)
 *
 * WAL mode + synchronous=NORMAL — durability is unnecessary because the DB is
 * a derived index that can be rebuilt from data.ndjson at any time.
 */
export function openIndexDb(typeDir: string): Database.Database {
  const dbPath = path.join(typeDir, INDEX_DB_FILE);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.prepare(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      ord INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      length INTEGER NOT NULL,
      fields_json TEXT NOT NULL,
      searchable TEXT NOT NULL
    )
  `).run();
  db.prepare("CREATE INDEX IF NOT EXISTS records_ord ON records(ord)").run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run();
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
  return db;
}
