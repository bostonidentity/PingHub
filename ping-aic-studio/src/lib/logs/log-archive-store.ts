import fs from "node:fs";
import { sourceDir, dayNdjsonPath, dayDbPath, dayKey } from "./log-archive-paths";
import { openDayDb } from "./log-index";
import type { LogIndexRow, RawLogEntry } from "./log-types";

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/**
 * Build the indexable columns from a raw entry (everything except the NDJSON
 * byte offset, which is only known at append time). Returns null when the entry
 * has no `payload._id` (no stable dedup key — skip it).
 */
export function extractRow(entry: RawLogEntry): Omit<LogIndexRow, "offset"> | null {
    const p = entry.payload ?? {};
    const id = str(p._id);
    if (!id) return null;
    const transactionId = str(p.transactionId);
    const eventName = str(p.eventName);
    const level = str(p.level);
    const realm = str(p.realm);
    const userId = str(p.userId) || str(p.principal);
    const payloadJson = JSON.stringify(entry);
    const length = Buffer.byteLength(payloadJson, "utf-8");
    const searchable = [eventName, transactionId, userId, realm, str(p.result)]
        .filter(Boolean).join(" ").toLowerCase();
    return { id, timestamp: entry.timestamp, transactionId, eventName, level, realm, userId, length, payloadJson, searchable };
}

export interface AppendResult {
    inserted: number;
    duplicates: number;
    /** Entries dropped for lacking a stable `payload._id`. */
    skipped: number;
    /** UTC day keys touched by this call. */
    days: string[];
}

/**
 * Append entries to the archive for `source`, partitioned by UTC day.
 *
 * Dedup authority is the per-day SQLite (`payload._id` PK, INSERT OR IGNORE).
 * Only entries that were newly inserted get appended to the day's NDJSON, so
 * overlapping pulls don't duplicate lines.
 *
 * Ordering caveat: the DB row is committed before its NDJSON line is appended.
 * A crash between the two leaves an orphaned DB row whose offset points to
 * absent NDJSON bytes; INSERT OR IGNORE then treats that id as a duplicate and
 * never re-appends it. The index is derived, so recovery is a rebuild from
 * NDJSON followed by re-pulling the affected window — a path the Phase A2 pull
 * runner will own.
 */
export function appendEntries(archiveRoot: string, source: string, entries: RawLogEntry[]): AppendResult {
    const result: AppendResult = { inserted: 0, duplicates: 0, skipped: 0, days: [] };
    if (entries.length === 0) return result;

    // Group entries by UTC day.
    const byDay = new Map<string, RawLogEntry[]>();
    for (const e of entries) {
        const day = dayKey(e.timestamp);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(e);
    }

    fs.mkdirSync(sourceDir(archiveRoot, source), { recursive: true });

    for (const [day, dayEntries] of byDay) {
        result.days.push(day);
        const ndjsonPath = dayNdjsonPath(archiveRoot, source, day);

        // Build candidate rows (skipping those without _id). Offsets are
        // assigned at insert time below, once we know each row is new.
        const rows: Omit<LogIndexRow, "offset">[] = [];
        for (const e of dayEntries) {
            const row = extractRow(e);
            if (!row) { result.skipped++; continue; }
            rows.push(row);
        }
        if (rows.length === 0) continue;

        const db = openDayDb(dayDbPath(archiveRoot, source, day));
        try {
            const stmt = db.prepare(
                "INSERT OR IGNORE INTO entries" +
                "(id, timestamp, transaction_id, event_name, level, realm, user_id, offset, length, payload_json, searchable)" +
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            );
            const newLines: string[] = [];
            // Offsets must reflect the on-disk NDJSON, so start from the current
            // file size and advance only for rows that are actually new.
            let writeOffset = fs.existsSync(ndjsonPath) ? fs.statSync(ndjsonPath).size : 0;
            const tx = db.transaction((batch: Omit<LogIndexRow, "offset">[]) => {
                for (const r of batch) {
                    const probe = stmt.run(
                        r.id, r.timestamp, r.transactionId, r.eventName, r.level, r.realm,
                        r.userId, writeOffset, r.length, r.payloadJson, r.searchable,
                    );
                    if (probe.changes === 1) {
                        newLines.push(r.payloadJson);
                        writeOffset += r.length + 1; // +1 for newline
                        result.inserted++;
                    } else {
                        result.duplicates++;
                    }
                }
            });
            tx(rows);
            if (newLines.length > 0) {
                fs.appendFileSync(ndjsonPath, newLines.map((l) => l + "\n").join(""));
            }
        } finally {
            db.close();
        }
    }
    return result;
}

/**
 * Read all stored entries for `source` whose timestamp falls in [from, to], by
 * reading the day-partition NDJSON files that overlap the range. NDJSON is the
 * source of truth, so reads go straight to it (the SQLite index is for
 * filtered/indexed queries, added in Phase B).
 */
export function readRange(archiveRoot: string, source: string, from: string, to: string): RawLogEntry[] {
    const dir = sourceDir(archiveRoot, source);
    if (!fs.existsSync(dir)) return [];
    const fromDay = dayKey(from);
    const toDay = dayKey(to);
    const out: RawLogEntry[] = [];
    const days = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".ndjson"))
        .map((f) => f.slice(0, -".ndjson".length))
        .filter((day) => day >= fromDay && day <= toDay)
        .sort();
    for (const day of days) {
        const content = fs.readFileSync(dayNdjsonPath(archiveRoot, source, day), "utf-8");
        for (const line of content.split("\n")) {
            if (!line) continue;
            const entry = JSON.parse(line) as RawLogEntry;
            if (entry.timestamp >= from && entry.timestamp <= to) out.push(entry);
        }
    }
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return out;
}
