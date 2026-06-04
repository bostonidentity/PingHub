import fs from "node:fs";
import { sourceDir, dayDbPath, dayKey } from "./log-archive-paths";
import { openDayDb, queryDay, countDay, type LogQueryFilters } from "./log-index";
import type { LogIndexRow } from "./log-types";

/** Safety cap on rows materialized in memory before pagination. */
const MAX_SCAN = 50_000;

export interface ArchiveQuery {
    sources: string[];
    from: string;
    to: string;
    eventName?: string;
    transactionId?: string;
    userId?: string;
    level?: string;
    text?: string;
    offset?: number;
    limit?: number;
}

export interface ArchiveQueryRow extends LogIndexRow {
    source: string;
}

export interface ArchiveQueryResult {
    /** Total matches across all sources/days (accurate even when capped). */
    total: number;
    /** The requested page, timestamp-ordered. */
    rows: ArchiveQueryRow[];
    /** True when matches exceeded MAX_SCAN; rows beyond the cap aren't paginated. */
    capped: boolean;
}

/**
 * Filtered, paginated query across the archive's day partitions for the given
 * sources. Counts are exact (per-day COUNT); rows are materialized up to
 * MAX_SCAN, merged timestamp-ordered, then sliced for the page.
 */
export function queryArchive(archiveRoot: string, q: ArchiveQuery): ArchiveQueryResult {
    const fromDay = dayKey(q.from);
    const toDay = dayKey(q.to);
    const filters: LogQueryFilters = {
        eventName: q.eventName,
        transactionId: q.transactionId,
        userId: q.userId,
        level: q.level,
        text: q.text,
        from: q.from,
        to: q.to,
    };

    let total = 0;
    let capped = false;
    const collected: ArchiveQueryRow[] = [];

    for (const source of q.sources) {
        const dir = sourceDir(archiveRoot, source);
        if (!fs.existsSync(dir)) continue;
        const days = fs.readdirSync(dir)
            .filter((f) => f.endsWith(".sqlite"))
            .map((f) => f.slice(0, -".sqlite".length))
            .filter((d) => d && d >= fromDay && d <= toDay)
            .sort();
        for (const day of days) {
            const db = openDayDb(dayDbPath(archiveRoot, source, day));
            try {
                total += countDay(db, filters);
                if (!capped) {
                    for (const r of queryDay(db, filters)) {
                        collected.push({ ...r, source });
                        if (collected.length >= MAX_SCAN) { capped = true; break; }
                    }
                }
            } finally {
                db.close();
            }
        }
    }

    collected.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.max(1, Math.min(q.limit ?? 100, 1000));
    return { total, rows: collected.slice(offset, offset + limit), capped };
}
