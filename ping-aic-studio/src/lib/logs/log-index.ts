import Database from "better-sqlite3";
import type { LogIndexRow } from "./log-types";

/** Bump when the on-disk index shape changes in a way that requires a rebuild. */
export const LOG_SCHEMA_VERSION = 1;

/**
 * Open (or create) a per-day log index DB. The DB is a derived index — it can
 * always be rebuilt from the day's NDJSON — so it runs in WAL +
 * synchronous=NORMAL. A stale schemaVersion drops `entries` for a rebuild.
 *
 * Schema:
 *   entries(id PK, timestamp, transaction_id, event_name, level, realm, user_id,
 *           offset, length, payload_json, searchable)
 *   meta(key PK, value)  -- schemaVersion
 */
export function openDayDb(dbPath: string): Database.Database {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();

    // Detect a stale schema BEFORE (re)creating `entries` so we can wipe it.
    // Two cases: (1) a recorded version that differs, or (2) an `entries` table
    // exists but no version was ever stamped (crash-orphaned / pre-versioning).
    const entriesExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'",
    ).get() !== undefined;
    const existing = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as
        | { value: string }
        | undefined;
    const stale =
        (existing && existing.value !== String(LOG_SCHEMA_VERSION)) ||
        (entriesExists && !existing);
    if (stale) {
        db.prepare("DROP TABLE IF EXISTS entries").run();
        db.prepare(
            "INSERT INTO meta(key,value) VALUES ('schemaVersion', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(String(LOG_SCHEMA_VERSION));
    }

    db.prepare(`
        CREATE TABLE IF NOT EXISTS entries (
            id TEXT PRIMARY KEY NOT NULL,
            timestamp TEXT NOT NULL,
            transaction_id TEXT NOT NULL,
            event_name TEXT NOT NULL,
            level TEXT NOT NULL,
            realm TEXT NOT NULL,
            user_id TEXT NOT NULL,
            offset INTEGER NOT NULL,
            length INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            searchable TEXT NOT NULL
        )
    `).run();
    db.prepare("CREATE INDEX IF NOT EXISTS entries_ts ON entries(timestamp)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS entries_txn ON entries(transaction_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS entries_event ON entries(event_name)").run();
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('schemaVersion', ?)").run(String(LOG_SCHEMA_VERSION));
    return db;
}

/** Insert rows with INSERT OR IGNORE; returns the count of NEWLY inserted rows. */
export function insertRows(db: Database.Database, rows: LogIndexRow[]): number {
    const stmt = db.prepare(
        "INSERT OR IGNORE INTO entries" +
        "(id, timestamp, transaction_id, event_name, level, realm, user_id, offset, length, payload_json, searchable)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let inserted = 0;
    const tx = db.transaction((batch: LogIndexRow[]) => {
        for (const r of batch) {
            const info = stmt.run(
                r.id, r.timestamp, r.transactionId, r.eventName, r.level, r.realm,
                r.userId, r.offset, r.length, r.payloadJson, r.searchable,
            );
            if (info.changes === 1) inserted++;
        }
    });
    tx(rows);
    return inserted;
}

export function countEntries(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
}

export interface LogQueryFilters {
    eventName?: string;
    transactionId?: string;
    userId?: string;
    level?: string;
    /** Inclusive ISO lower bound on timestamp. */
    from?: string;
    /** Inclusive ISO upper bound on timestamp. */
    to?: string;
    text?: string;
    limit?: number;
    offset?: number;
}

/** Build the shared WHERE clause + params for queryDay/countDay. */
function buildWhere(filters: LogQueryFilters): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.eventName) { where.push("event_name = ?"); params.push(filters.eventName); }
    if (filters.transactionId) { where.push("transaction_id = ?"); params.push(filters.transactionId); }
    if (filters.userId) { where.push("user_id = ?"); params.push(filters.userId); }
    if (filters.level) { where.push("level = ?"); params.push(filters.level); }
    if (filters.from) { where.push("timestamp >= ?"); params.push(filters.from); }
    if (filters.to) { where.push("timestamp <= ?"); params.push(filters.to); }
    if (filters.text) { where.push("searchable LIKE ?"); params.push(`%${filters.text.toLowerCase()}%`); }
    return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

/** Query a single day DB; rows ordered by timestamp, with optional limit/offset. */
export function queryDay(db: Database.Database, filters: LogQueryFilters): LogIndexRow[] {
    const { sql: whereSql, params } = buildWhere(filters);
    const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.floor(filters.limit as number)) : null;
    const offset = Number.isFinite(filters.offset) ? Math.max(0, Math.floor(filters.offset as number)) : 0;
    const sql =
        "SELECT id, timestamp, transaction_id AS transactionId, event_name AS eventName, level, realm," +
        " user_id AS userId, offset, length, payload_json AS payloadJson, searchable FROM entries" +
        whereSql +
        " ORDER BY timestamp ASC" +
        // SQLite requires LIMIT before OFFSET; use -1 (no limit) when only offset is set.
        (limit !== null ? ` LIMIT ${limit}` : (offset > 0 ? " LIMIT -1" : "")) +
        (offset > 0 ? ` OFFSET ${offset}` : "");
    return db.prepare(sql).all(...params) as LogIndexRow[];
}

/** Count rows in a day DB matching the filters (ignores limit/offset). */
export function countDay(db: Database.Database, filters: LogQueryFilters): number {
    const { sql: whereSql, params } = buildWhere(filters);
    const r = db.prepare(`SELECT COUNT(*) AS n FROM entries${whereSql}`).get(...params) as { n: number };
    return r.n;
}
