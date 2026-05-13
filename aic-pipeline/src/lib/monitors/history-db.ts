/**
 * SQLite-backed history store for server-status and TLS checks.
 *
 * File lives in ENVIRONMENTS_DIR/monitor-history.db. Two tables:
 *   - server_history(target_id, ts, status, http_status, latency_ms, message)
 *   - tls_history(target_id, ts, status, days_remaining, valid_to, message)
 *
 * Defaults: 30-day retention. Pruning runs on first append per process
 * and at most once per hour.
 */

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

import { ENVIRONMENTS_DIR } from "../paths";
import type { MonitorCheckResult, MonitorStatus } from "./types";
import type { TlsCheckResult, TlsStatus } from "./tls-types";

const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1h

let _db: Database.Database | null = null;
let _lastPrune = 0;

function getDb(): Database.Database {
    if (_db) return _db;
    fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
    const file = path.join(ENVIRONMENTS_DIR, "monitor-history.db");
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS server_history (
            target_id   TEXT NOT NULL,
            ts          INTEGER NOT NULL,
            status      TEXT NOT NULL,
            http_status INTEGER,
            latency_ms  INTEGER,
            message     TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_server_history_target_ts
            ON server_history(target_id, ts);

        CREATE TABLE IF NOT EXISTS tls_history (
            target_id      TEXT NOT NULL,
            ts             INTEGER NOT NULL,
            status         TEXT NOT NULL,
            days_remaining REAL,
            valid_to       TEXT,
            message        TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_tls_history_target_ts
            ON tls_history(target_id, ts);
    `);
    _db = db;
    return db;
}

function maybePrune() {
    const now = Date.now();
    if (now - _lastPrune < PRUNE_INTERVAL_MS) return;
    _lastPrune = now;
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const db = getDb();
    db.prepare("DELETE FROM server_history WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM tls_history    WHERE ts < ?").run(cutoff);
}

// --- writes ---------------------------------------------------------------

export function recordServerResults(results: MonitorCheckResult[]) {
    if (!results.length) return;
    const db = getDb();
    const stmt = db.prepare(
        `INSERT INTO server_history (target_id, ts, status, http_status, latency_ms, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction((rows: MonitorCheckResult[]) => {
        for (const r of rows) {
            stmt.run(
                r.id,
                new Date(r.checkedAt).getTime(),
                r.status,
                r.httpStatus ?? null,
                Math.round(r.latencyMs ?? 0),
                r.message ?? null,
            );
        }
    });
    tx(results);
    maybePrune();
}

export function recordTlsResults(results: TlsCheckResult[]) {
    if (!results.length) return;
    const db = getDb();
    const stmt = db.prepare(
        `INSERT INTO tls_history (target_id, ts, status, days_remaining, valid_to, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction((rows: TlsCheckResult[]) => {
        for (const r of rows) {
            stmt.run(
                r.id,
                new Date(r.checkedAt).getTime(),
                r.status,
                r.daysRemaining ?? null,
                r.validTo ?? null,
                r.message ?? null,
            );
        }
    });
    tx(results);
    maybePrune();
}

// --- reads ----------------------------------------------------------------

export interface ServerHistoryPoint {
    ts: number;
    status: MonitorStatus;
    httpStatus: number | null;
    latencyMs: number;
    message: string | null;
}

export interface TlsHistoryPoint {
    ts: number;
    status: TlsStatus;
    daysRemaining: number | null;
    validTo: string | null;
    message: string | null;
}

export interface ServerHistoryBucket {
    /** Bucket start in epoch ms. */
    ts: number;
    /** Counts within the bucket. */
    okCount: number;
    degradedCount: number;
    downCount: number;
    unknownCount: number;
    /** Dominant status (worst wins: down > degraded > unknown > ok). */
    status: MonitorStatus;
    p50: number | null;
    p95: number | null;
    avg: number | null;
    samples: number;
}

export interface TlsHistoryBucket {
    ts: number;
    /** Last sample's status in the bucket. */
    status: TlsStatus;
    daysRemaining: number | null;
    samples: number;
}

function rollupServer(rows: ServerHistoryPoint[]): Omit<ServerHistoryBucket, "ts"> {
    let ok = 0,
        deg = 0,
        down = 0,
        unk = 0;
    const lats: number[] = [];
    for (const r of rows) {
        if (r.status === "ok") ok++;
        else if (r.status === "degraded") deg++;
        else if (r.status === "down") down++;
        else unk++;
        if (typeof r.latencyMs === "number" && r.latencyMs > 0) lats.push(r.latencyMs);
    }
    lats.sort((a, b) => a - b);
    const pct = (p: number) =>
        lats.length === 0 ? null : lats[Math.min(lats.length - 1, Math.floor((p / 100) * lats.length))];
    const avg = lats.length === 0 ? null : Math.round(lats.reduce((s, n) => s + n, 0) / lats.length);
    const status: MonitorStatus =
        down > 0 ? "down" : deg > 0 ? "degraded" : ok > 0 ? "ok" : "unknown";
    return {
        okCount: ok,
        degradedCount: deg,
        downCount: down,
        unknownCount: unk,
        status,
        p50: pct(50),
        p95: pct(95),
        avg,
        samples: rows.length,
    };
}

export function getServerHistory(
    targetId: string,
    fromMs: number,
    toMs: number,
    bucketMs: number,
): ServerHistoryBucket[] {
    const db = getDb();
    const rows = db
        .prepare(
            `SELECT ts, status, http_status AS httpStatus, latency_ms AS latencyMs, message
             FROM server_history
             WHERE target_id = ? AND ts >= ? AND ts < ?
             ORDER BY ts ASC`,
        )
        .all(targetId, fromMs, toMs) as ServerHistoryPoint[];

    if (bucketMs <= 0) {
        // Raw mode: one bucket per row.
        return rows.map((r) => ({
            ts: r.ts,
            ...rollupServer([r]),
        }));
    }

    const buckets = new Map<number, ServerHistoryPoint[]>();
    for (const r of rows) {
        const key = Math.floor(r.ts / bucketMs) * bucketMs;
        const arr = buckets.get(key) ?? [];
        arr.push(r);
        buckets.set(key, arr);
    }
    const out: ServerHistoryBucket[] = [];
    for (const [ts, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        out.push({ ts, ...rollupServer(list) });
    }
    return out;
}

export function getTlsHistory(
    targetId: string,
    fromMs: number,
    toMs: number,
    bucketMs: number,
): TlsHistoryBucket[] {
    const db = getDb();
    const rows = db
        .prepare(
            `SELECT ts, status, days_remaining AS daysRemaining, valid_to AS validTo, message
             FROM tls_history
             WHERE target_id = ? AND ts >= ? AND ts < ?
             ORDER BY ts ASC`,
        )
        .all(targetId, fromMs, toMs) as TlsHistoryPoint[];

    if (bucketMs <= 0) {
        return rows.map((r) => ({
            ts: r.ts,
            status: r.status,
            daysRemaining: r.daysRemaining,
            samples: 1,
        }));
    }

    const buckets = new Map<number, TlsHistoryPoint[]>();
    for (const r of rows) {
        const key = Math.floor(r.ts / bucketMs) * bucketMs;
        const arr = buckets.get(key) ?? [];
        arr.push(r);
        buckets.set(key, arr);
    }
    const out: TlsHistoryBucket[] = [];
    for (const [ts, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        // For TLS, take the last sample per bucket (daysRemaining trends down).
        const last = list[list.length - 1];
        out.push({
            ts,
            status: last.status,
            daysRemaining: last.daysRemaining,
            samples: list.length,
        });
    }
    return out;
}

/** Useful for the History tab to count availability over the range. */
export function getServerAvailability(
    targetId: string,
    fromMs: number,
    toMs: number,
): { ok: number; degraded: number; down: number; unknown: number; total: number } {
    const db = getDb();
    const row = db
        .prepare(
            `SELECT
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)       AS ok,
                SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
                SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END)     AS down,
                SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END)  AS unknown,
                COUNT(*) AS total
             FROM server_history
             WHERE target_id = ? AND ts >= ? AND ts < ?`,
        )
        .get(targetId, fromMs, toMs) as {
            ok: number | null;
            degraded: number | null;
            down: number | null;
            unknown: number | null;
            total: number;
        };
    return {
        ok: row.ok ?? 0,
        degraded: row.degraded ?? 0,
        down: row.down ?? 0,
        unknown: row.unknown ?? 0,
        total: row.total ?? 0,
    };
}
