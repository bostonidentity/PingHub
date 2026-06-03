import fs from "node:fs";
import { sourceDir, dayNdjsonPath, dayDbPath, dayKey } from "./log-archive-paths";
import { openDayDb } from "./log-index";
import type { LogIndexRow, RawLogEntry } from "./log-types";

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/**
 * Build an index row from a raw entry. `offset` is the byte position the line
 * will occupy in the day NDJSON. Returns null when the entry has no
 * `payload._id` (no stable dedup key — skip it).
 */
export function extractRow(entry: RawLogEntry, offset: number): LogIndexRow | null {
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
    return { id, timestamp: entry.timestamp, transactionId, eventName, level, realm, userId, offset, length, payloadJson, searchable };
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
 * overlapping pulls don't duplicate lines. The SQLite index is derived and
 * rebuildable from NDJSON, so a crash between the DB commit and the NDJSON
 * append self-heals on the next (idempotent) pull.
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

        // Build candidate rows (skipping those without _id).
        const rows: LogIndexRow[] = [];
        for (const e of dayEntries) {
            const row = extractRow(e, 0); // offset assigned during insert below
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
            const tx = db.transaction((batch: LogIndexRow[]) => {
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
