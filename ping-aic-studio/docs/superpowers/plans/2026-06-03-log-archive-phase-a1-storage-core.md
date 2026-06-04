# Log Archive — Phase A1 (Storage Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local-disk storage layer for AIC logs — partitioned NDJSON + per-day SQLite index with `_id` dedup, plus a coverage manifest — as pure, independently-tested libraries.

**Architecture:** Logs are stored under `ENVIRONMENTS_DIR/{env}/log-data/{source}/{YYYY-MM-DD}.ndjson` (append-only source of truth) with a sibling `{YYYY-MM-DD}.sqlite` derived index. Dedup is by `payload._id` via SQLite `INSERT OR IGNORE`; an NDJSON line is appended only when the insert is new. A top-level `manifest.json` records merged covered time ranges per source. This phase is storage only — no AIC fetching, no API routes, no UI (those are Phase A2+).

**Tech Stack:** TypeScript, Node `fs`, `better-sqlite3` (already a shipped dependency), Vitest. Follows the existing `src/lib/data/index-db.ts` SQLite conventions.

**Reference spec:** `docs/superpowers/specs/2026-06-03-log-archive-design.md`

---

## File Structure

All new files under `src/lib/logs/`:

- `log-types.ts` — shared types (`RawLogEntry`, `TimeRange`, `LogArchiveManifest`, `LogIndexRow`). No logic.
- `log-archive-paths.ts` — pure path + day-key helpers. Takes an explicit `archiveRoot` (the `log-data` dir) so it's testable without globals; one wrapper resolves `archiveRoot` from `ENVIRONMENTS_DIR`.
- `manifest.ts` — pure covered-range merge + manifest read/write.
- `log-index.ts` — per-day SQLite open / insert (OR IGNORE) / count / query.
- `log-archive-store.ts` — ties it together: column extraction, `appendEntries` (dedup + partition + NDJSON append), `readRange`.

Tests are co-located (`*.test.ts`) per the repo's Vitest convention (`vitest.config.ts` includes `src/**/*.test.ts`).

**Design notes baked in from the timing test:**
- Dedup key is `payload._id` (NOT top-level; timestamps are sub-millisecond-close and unsafe).
- The SQLite index is *derived* and rebuildable from NDJSON; NDJSON is the source of truth. `appendEntries` inserts into SQLite to decide newness, then appends only-new lines to NDJSON. A crash between the two self-heals on the next pull (idempotent `OR IGNORE`) — acceptable for a derived index.

---

## Task 1: Shared types + path/day-key helpers

**Files:**
- Create: `src/lib/logs/log-types.ts`
- Create: `src/lib/logs/log-archive-paths.ts`
- Test: `src/lib/logs/log-archive-paths.test.ts`

- [ ] **Step 1: Write the types file** (no test — pure declarations)

Create `src/lib/logs/log-types.ts`:

```typescript
/** A raw log entry as returned by AIC /monitoring/logs (one element of `result`). */
export interface RawLogEntry {
    timestamp: string;
    source?: string;
    type?: string;
    payload: Record<string, unknown>;
}

/** Half-open-ish ISO time range [from, to]. */
export interface TimeRange {
    from: string;
    to: string;
}

export interface SourceManifest {
    /** Merged, non-overlapping ranges actually pulled, sorted by `from`. */
    coveredRanges: TimeRange[];
    /** High-water mark for "catch up to now". */
    lastPulledTo?: string;
    /** Total deduped entries stored for this source. */
    entryCount?: number;
}

export interface LogArchiveManifest {
    sources: Record<string, SourceManifest>;
}

/** A row as stored in the per-day SQLite index. */
export interface LogIndexRow {
    id: string;
    timestamp: string;
    transactionId: string;
    eventName: string;
    level: string;
    realm: string;
    userId: string;
    /** Byte offset of the entry's line in the day NDJSON. */
    offset: number;
    /** Byte length of the line, excluding the trailing newline. */
    length: number;
    /** The full raw entry, JSON-stringified (what gets written to NDJSON). */
    payloadJson: string;
    /** Lowercased concatenation of key fields for LIKE search. */
    searchable: string;
}
```

- [ ] **Step 2: Write the failing test** for path helpers

Create `src/lib/logs/log-archive-paths.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import path from "node:path";
import { dayKey, sourceDir, dayNdjsonPath, dayDbPath, manifestPath } from "./log-archive-paths";

describe("log-archive-paths", () => {
    it("derives a UTC day key from an ISO timestamp with nanoseconds", () => {
        expect(dayKey("2026-06-02T00:00:00.005593365Z")).toBe("2026-06-02");
    });

    it("derives the UTC day even when the instant is late in the day UTC", () => {
        expect(dayKey("2026-06-02T23:59:59.999Z")).toBe("2026-06-02");
    });

    it("throws on an unparseable timestamp", () => {
        expect(() => dayKey("not-a-date")).toThrow(/invalid timestamp/);
    });

    it("builds source/day paths under the archive root", () => {
        const root = "/tmp/log-data";
        expect(sourceDir(root, "am-authentication")).toBe(path.join(root, "am-authentication"));
        expect(dayNdjsonPath(root, "am-authentication", "2026-06-02"))
            .toBe(path.join(root, "am-authentication", "2026-06-02.ndjson"));
        expect(dayDbPath(root, "am-authentication", "2026-06-02"))
            .toBe(path.join(root, "am-authentication", "2026-06-02.sqlite"));
        expect(manifestPath(root)).toBe(path.join(root, "manifest.json"));
    });

    it("rejects path-traversal in source names", () => {
        expect(() => sourceDir("/tmp/log-data", "../evil")).toThrow(/invalid source/);
        expect(() => dayNdjsonPath("/tmp/log-data", "am-access", "../../etc")).toThrow(/invalid day/);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/log-archive-paths.test.ts`
Expected: FAIL — `Cannot find module './log-archive-paths'`.

- [ ] **Step 4: Implement the path helpers**

Create `src/lib/logs/log-archive-paths.ts`:

```typescript
import path from "node:path";
import { ENVIRONMENTS_DIR } from "@/lib/paths";

/** UTC `YYYY-MM-DD` for an ISO timestamp (handles nanosecond precision). */
export function dayKey(isoTimestamp: string): string {
    const d = new Date(isoTimestamp);
    if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${isoTimestamp}`);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** A single, safe path segment: no separators, no traversal. */
function safeSeg(value: string, label: string): string {
    if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
        throw new Error(`invalid ${label}: ${value}`);
    }
    return value;
}

/** Archive root for an environment: `ENVIRONMENTS_DIR/{env}/log-data`. */
export function logDataDir(env: string): string {
    return path.join(ENVIRONMENTS_DIR, safeSeg(env, "env"), "log-data");
}

export function sourceDir(archiveRoot: string, source: string): string {
    return path.join(archiveRoot, safeSeg(source, "source"));
}

export function dayNdjsonPath(archiveRoot: string, source: string, day: string): string {
    return path.join(sourceDir(archiveRoot, source), `${safeSeg(day, "day")}.ndjson`);
}

export function dayDbPath(archiveRoot: string, source: string, day: string): string {
    return path.join(sourceDir(archiveRoot, source), `${safeSeg(day, "day")}.sqlite`);
}

export function manifestPath(archiveRoot: string): string {
    return path.join(archiveRoot, "manifest.json");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/log-archive-paths.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/log-types.ts src/lib/logs/log-archive-paths.ts src/lib/logs/log-archive-paths.test.ts
git commit -m "feat(logs): log-archive path + day-key helpers and shared types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Covered-range merge + manifest read/write

**Files:**
- Create: `src/lib/logs/manifest.ts`
- Test: `src/lib/logs/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/logs/manifest.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { mergeRanges, addCoveredRange, readManifest, writeManifest } from "./manifest";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-manifest-"));
}

describe("mergeRanges", () => {
    it("merges overlapping ranges", () => {
        const merged = mergeRanges([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T12:00:00Z" },
            { from: "2026-06-01T06:00:00Z", to: "2026-06-01T18:00:00Z" },
        ]);
        expect(merged).toEqual([{ from: "2026-06-01T00:00:00Z", to: "2026-06-01T18:00:00Z" }]);
    });

    it("merges adjacent/touching ranges", () => {
        const merged = mergeRanges([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T12:00:00Z" },
            { from: "2026-06-01T12:00:00Z", to: "2026-06-02T00:00:00Z" },
        ]);
        expect(merged).toEqual([{ from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" }]);
    });

    it("keeps disjoint ranges separate and sorted", () => {
        const merged = mergeRanges([
            { from: "2026-06-03T00:00:00Z", to: "2026-06-03T01:00:00Z" },
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T01:00:00Z" },
        ]);
        expect(merged).toEqual([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-01T01:00:00Z" },
            { from: "2026-06-03T00:00:00Z", to: "2026-06-03T01:00:00Z" },
        ]);
    });

    it("addCoveredRange folds a new range into a source and advances lastPulledTo", () => {
        const m = { sources: {} };
        const updated = addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        expect(updated.sources["am-access"].coveredRanges).toEqual([
            { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" },
        ]);
        expect(updated.sources["am-access"].lastPulledTo).toBe("2026-06-02T00:00:00Z");
    });

    it("addCoveredRange does not move lastPulledTo backwards", () => {
        let m = { sources: {} };
        m = addCoveredRange(m, "am-access", { from: "2026-06-05T00:00:00Z", to: "2026-06-06T00:00:00Z" });
        m = addCoveredRange(m, "am-access", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        expect(m.sources["am-access"].lastPulledTo).toBe("2026-06-06T00:00:00Z");
    });

    it("readManifest returns an empty manifest when the file is absent", () => {
        const root = tmpRoot();
        expect(readManifest(root)).toEqual({ sources: {} });
    });

    it("writeManifest then readManifest round-trips", () => {
        const root = tmpRoot();
        const m = addCoveredRange({ sources: {} }, "am-core", { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" });
        writeManifest(root, m);
        expect(readManifest(root)).toEqual(m);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/manifest.test.ts`
Expected: FAIL — `Cannot find module './manifest'`.

- [ ] **Step 3: Implement the manifest module**

Create `src/lib/logs/manifest.ts`:

```typescript
import fs from "node:fs";
import { manifestPath } from "./log-archive-paths";
import type { LogArchiveManifest, SourceManifest, TimeRange } from "./log-types";

/** Merge overlapping/adjacent ISO ranges into a sorted, minimal set. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a.from.localeCompare(b.from));
    const out: TimeRange[] = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1];
        const cur = sorted[i];
        // Overlap or touch: next starts at or before the current end.
        if (cur.from <= last.to) {
            if (cur.to > last.to) last.to = cur.to;
        } else {
            out.push({ ...cur });
        }
    }
    return out;
}

/** Return a new manifest with `range` folded into `source`'s coverage. */
export function addCoveredRange(
    manifest: LogArchiveManifest,
    source: string,
    range: TimeRange,
): LogArchiveManifest {
    const prev: SourceManifest = manifest.sources[source] ?? { coveredRanges: [] };
    const coveredRanges = mergeRanges([...prev.coveredRanges, range]);
    const lastPulledTo = !prev.lastPulledTo || range.to > prev.lastPulledTo
        ? range.to
        : prev.lastPulledTo;
    return {
        ...manifest,
        sources: {
            ...manifest.sources,
            [source]: { ...prev, coveredRanges, lastPulledTo },
        },
    };
}

export function readManifest(archiveRoot: string): LogArchiveManifest {
    const p = manifestPath(archiveRoot);
    if (!fs.existsSync(p)) return { sources: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as LogArchiveManifest;
        return parsed && typeof parsed === "object" && parsed.sources ? parsed : { sources: {} };
    } catch {
        return { sources: {} };
    }
}

export function writeManifest(archiveRoot: string, manifest: LogArchiveManifest): void {
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(manifestPath(archiveRoot), JSON.stringify(manifest, null, 2));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/manifest.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/logs/manifest.ts src/lib/logs/manifest.test.ts
git commit -m "feat(logs): covered-range merge + manifest read/write

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Per-day SQLite index (open / insert OR IGNORE / count / query)

**Files:**
- Create: `src/lib/logs/log-index.ts`
- Test: `src/lib/logs/log-index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/logs/log-index.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { openDayDb, insertRows, countEntries, queryDay, LOG_SCHEMA_VERSION } from "./log-index";
import type { LogIndexRow } from "./log-types";

function tmpDb(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "log-idx-")), "2026-06-02.sqlite");
}

function row(over: Partial<LogIndexRow> = {}): LogIndexRow {
    return {
        id: "id-1", timestamp: "2026-06-02T00:00:00Z", transactionId: "txn-1",
        eventName: "AM-TREE-LOGIN-COMPLETED", level: "INFO", realm: "/alpha", userId: "user-1",
        offset: 0, length: 10, payloadJson: '{"_id":"id-1"}', searchable: "am-tree-login-completed txn-1 user-1 /alpha",
        ...over,
    };
}

describe("log-index", () => {
    it("creates schema and stamps the version on first open", () => {
        const db = openDayDb(tmpDb());
        const meta = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string };
        expect(meta.value).toBe(String(LOG_SCHEMA_VERSION));
        db.close();
    });

    it("inserts rows and counts them", () => {
        const db = openDayDb(tmpDb());
        const inserted = insertRows(db, [row({ id: "a" }), row({ id: "b" })]);
        expect(inserted).toBe(2);
        expect(countEntries(db)).toBe(2);
        db.close();
    });

    it("dedupes by id via INSERT OR IGNORE (returns only newly inserted count)", () => {
        const db = openDayDb(tmpDb());
        expect(insertRows(db, [row({ id: "a" }), row({ id: "b" })])).toBe(2);
        expect(insertRows(db, [row({ id: "b" }), row({ id: "c" })])).toBe(1); // only c is new
        expect(countEntries(db)).toBe(3);
        db.close();
    });

    it("queryDay filters by eventName and free text", () => {
        const db = openDayDb(tmpDb());
        insertRows(db, [
            row({ id: "a", eventName: "AM-NODE-LOGIN-COMPLETED", searchable: "am-node-login-completed txn-1 alice /alpha", payloadJson: '{"u":"alice"}' }),
            row({ id: "b", eventName: "AM-TREE-LOGIN-COMPLETED", searchable: "am-tree-login-completed txn-2 bob /alpha", payloadJson: '{"u":"bob"}' }),
        ]);
        const byEvent = queryDay(db, { eventName: "AM-TREE-LOGIN-COMPLETED" });
        expect(byEvent.map((r) => r.payloadJson)).toEqual(['{"u":"bob"}']);
        const byText = queryDay(db, { text: "alice" });
        expect(byText.map((r) => r.payloadJson)).toEqual(['{"u":"alice"}']);
        db.close();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/log-index.test.ts`
Expected: FAIL — `Cannot find module './log-index'`.

- [ ] **Step 3: Implement the index module**

Create `src/lib/logs/log-index.ts`:

```typescript
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

    const existing = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as
        | { value: string }
        | undefined;
    if (existing && existing.value !== String(LOG_SCHEMA_VERSION)) {
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
    text?: string;
    limit?: number;
}

/** Query a single day DB. Returns matching rows' payload JSON + key columns, ordered by timestamp. */
export function queryDay(db: Database.Database, filters: LogQueryFilters): LogIndexRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.eventName) { where.push("event_name = ?"); params.push(filters.eventName); }
    if (filters.transactionId) { where.push("transaction_id = ?"); params.push(filters.transactionId); }
    if (filters.userId) { where.push("user_id = ?"); params.push(filters.userId); }
    if (filters.text) { where.push("searchable LIKE ?"); params.push(`%${filters.text.toLowerCase()}%`); }
    const sql =
        "SELECT id, timestamp, transaction_id AS transactionId, event_name AS eventName, level, realm," +
        " user_id AS userId, offset, length, payload_json AS payloadJson, searchable FROM entries" +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        " ORDER BY timestamp ASC" +
        (filters.limit ? ` LIMIT ${Math.max(1, Math.floor(filters.limit))}` : "");
    return db.prepare(sql).all(...params) as LogIndexRow[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/log-index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/logs/log-index.ts src/lib/logs/log-index.test.ts
git commit -m "feat(logs): per-day SQLite log index with _id dedup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Store — column extraction + appendEntries (dedup + partition + NDJSON)

**Files:**
- Create: `src/lib/logs/log-archive-store.ts`
- Test: `src/lib/logs/log-archive-store.test.ts`

- [ ] **Step 1: Write the failing test** for extraction + append

Create `src/lib/logs/log-archive-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { extractRow, appendEntries } from "./log-archive-store";
import { dayNdjsonPath } from "./log-archive-paths";
import type { RawLogEntry } from "./log-types";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-store-"));
}

function entry(id: string, ts: string, over: Record<string, unknown> = {}): RawLogEntry {
    return {
        timestamp: ts,
        source: "am-authentication",
        payload: {
            _id: id, transactionId: "txn-1", eventName: "AM-TREE-LOGIN-COMPLETED",
            level: "INFO", realm: "/alpha", principal: "alice", ...over,
        },
    };
}

describe("extractRow", () => {
    it("pulls indexable columns from payload, preferring userId then principal", () => {
        const r = extractRow(entry("a", "2026-06-02T00:00:00Z", { userId: "bob" }), 0);
        expect(r).toMatchObject({
            id: "a", transactionId: "txn-1", eventName: "AM-TREE-LOGIN-COMPLETED",
            level: "INFO", realm: "/alpha", userId: "bob",
        });
        expect(r!.searchable).toContain("am-tree-login-completed");
    });

    it("falls back to principal when userId is absent", () => {
        expect(extractRow(entry("a", "2026-06-02T00:00:00Z"), 0)!.userId).toBe("alice");
    });

    it("returns null when payload._id is missing (no stable dedup key)", () => {
        const e: RawLogEntry = { timestamp: "2026-06-02T00:00:00Z", payload: { eventName: "X" } };
        expect(extractRow(e, 0)).toBeNull();
    });
});

describe("appendEntries", () => {
    it("writes NDJSON + index, partitioned by UTC day, and reports counts", () => {
        const root = tmpRoot();
        const res = appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T00:00:00Z"),
            entry("b", "2026-06-02T23:00:00Z"),
            entry("c", "2026-06-03T00:30:00Z"),
        ]);
        expect(res.inserted).toBe(3);
        expect(res.duplicates).toBe(0);
        expect(res.days.sort()).toEqual(["2026-06-02", "2026-06-03"]);

        const day2 = fs.readFileSync(dayNdjsonPath(root, "am-authentication", "2026-06-02"), "utf-8")
            .trim().split("\n");
        expect(day2).toHaveLength(2);
        expect(JSON.parse(day2[0]).payload._id).toBe("a");
    });

    it("dedupes across calls — re-appending the same entries adds nothing", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [entry("a", "2026-06-02T00:00:00Z")]);
        const res2 = appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T00:00:00Z"),
            entry("d", "2026-06-02T01:00:00Z"),
        ]);
        expect(res2.inserted).toBe(1);
        expect(res2.duplicates).toBe(1);
        const lines = fs.readFileSync(dayNdjsonPath(root, "am-authentication", "2026-06-02"), "utf-8")
            .trim().split("\n");
        expect(lines).toHaveLength(2); // a (from call 1) + d (from call 2); a not duplicated
    });

    it("skips entries with no payload._id", () => {
        const root = tmpRoot();
        const res = appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T00:00:00Z"),
            { timestamp: "2026-06-02T00:00:01Z", payload: { eventName: "no-id" } },
        ]);
        expect(res.inserted).toBe(1);
        expect(res.skipped).toBe(1);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/log-archive-store.test.ts`
Expected: FAIL — `Cannot find module './log-archive-store'`.

- [ ] **Step 3: Implement extraction + appendEntries**

Create `src/lib/logs/log-archive-store.ts`:

```typescript
import fs from "node:fs";
import { sourceDir, dayNdjsonPath, dayDbPath, dayKey } from "./log-archive-paths";
import { openDayDb, insertRows } from "./log-index";
import type { LogIndexRow, RawLogEntry } from "./log-types";

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/**
 * Build an index row from a raw entry. `lineStr` is the exact NDJSON line that
 * will be written; `offset` is its byte position in the day file. Returns null
 * when the entry has no `payload._id` (no stable dedup key — skip it).
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
        let offset = fs.existsSync(ndjsonPath) ? fs.statSync(ndjsonPath).size : 0;

        // Build candidate rows (skipping those without _id), tracking byte offsets.
        const rows: LogIndexRow[] = [];
        for (const e of dayEntries) {
            const row = extractRow(e, offset);
            if (!row) { result.skipped++; continue; }
            rows.push(row);
            offset += row.length + 1; // +1 for newline
        }
        if (rows.length === 0) continue;

        const db = openDayDb(dayDbPath(archiveRoot, source, day));
        try {
            // INSERT OR IGNORE decides newness. We then need to know WHICH rows
            // were new to append only those to NDJSON. Insert one-by-one so we
            // can map each row to its inserted/duplicate status while staying in
            // a single transaction for speed.
            const stmt = db.prepare(
                "INSERT OR IGNORE INTO entries" +
                "(id, timestamp, transaction_id, event_name, level, realm, user_id, offset, length, payload_json, searchable)" +
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            );
            const newLines: string[] = [];
            // Recompute offsets for ONLY the new rows so NDJSON offsets stay
            // contiguous even when some candidates turn out to be duplicates.
            let writeOffset = fs.existsSync(ndjsonPath) ? fs.statSync(ndjsonPath).size : 0;
            const tx = db.transaction((batch: LogIndexRow[]) => {
                for (const r of batch) {
                    const probe = stmt.run(
                        r.id, r.timestamp, r.transactionId, r.eventName, r.level, r.realm,
                        r.userId, writeOffset, r.length, r.payloadJson, r.searchable,
                    );
                    if (probe.changes === 1) {
                        newLines.push(r.payloadJson);
                        writeOffset += r.length + 1;
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
```

Note: `insertRows` from `log-index` is intentionally NOT used here — `appendEntries` needs per-row insert/duplicate status to decide which NDJSON lines to append, and it must assign the correct on-disk byte offset to each newly inserted row. `insertRows` remains the simpler entry point for callers (e.g. an index rebuild) that don't write NDJSON.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/log-archive-store.test.ts`
Expected: PASS (extractRow: 3, appendEntries: 3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/logs/log-archive-store.ts src/lib/logs/log-archive-store.test.ts
git commit -m "feat(logs): partitioned append with _id dedup (NDJSON + index)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Store — readRange across day partitions

**Files:**
- Modify: `src/lib/logs/log-archive-store.ts` (add `readRange`)
- Test: `src/lib/logs/log-archive-store.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test** — append to the existing test file

Add this describe block to `src/lib/logs/log-archive-store.test.ts`:

```typescript
import { readRange } from "./log-archive-store"; // add to existing imports at top

describe("readRange", () => {
    it("returns entries across day partitions, filtered to [from,to] and sorted by timestamp", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z"),
            entry("b", "2026-06-02T23:30:00Z"),
            entry("c", "2026-06-03T00:30:00Z"),
            entry("d", "2026-06-04T00:30:00Z"),
        ]);
        const got = readRange(root, "am-authentication", "2026-06-02T12:00:00Z", "2026-06-03T12:00:00Z");
        expect(got.map((e) => e.payload._id)).toEqual(["b", "c"]);
    });

    it("returns an empty array when the source has no data", () => {
        const root = tmpRoot();
        expect(readRange(root, "am-access", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toEqual([]);
    });
});
```

(Move the `readRange` import up next to the existing `extractRow, appendEntries` import — do not add a duplicate import statement.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/logs/log-archive-store.test.ts`
Expected: FAIL — `readRange is not a function` / not exported.

- [ ] **Step 3: Implement readRange**

Add to `src/lib/logs/log-archive-store.ts`:

```typescript
import { sourceDir, dayNdjsonPath, dayDbPath, dayKey } from "./log-archive-paths";
// ^ already imported at top — ensure `sourceDir` and `dayNdjsonPath` are present.

/**
 * Read all stored entries for `source` whose timestamp falls in [from, to],
 * by reading the day-partition NDJSON files that overlap the range. NDJSON is
 * the source of truth, so reads go straight to it (the SQLite index is for
 * filtered/indexed queries, added in Phase B).
 */
export function readRange(archiveRoot: string, source: string, from: string, to: string): RawLogEntry[] {
    const dir = sourceDir(archiveRoot, source);
    if (!fs.existsSync(dir)) return [];
    const fromDay = dayKey(from);
    const toDay = dayKey(to);
    const out: RawLogEntry[] = [];
    const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".ndjson"))
        .map((f) => f.slice(0, -".ndjson".length))
        .filter((day) => day >= fromDay && day <= toDay)
        .sort();
    for (const day of files) {
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
```

(`dayDbPath` is already imported for `appendEntries`; keep the single import line and just confirm `dayKey`, `sourceDir`, `dayNdjsonPath` are all in it. Do not introduce a second import from `./log-archive-paths`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/logs/log-archive-store.test.ts`
Expected: PASS (all blocks, incl. readRange: 2).

- [ ] **Step 5: Run the full logs suite + typecheck + lint**

Run:
```bash
npx vitest run src/lib/logs/
npx tsc --noEmit
npx eslint src/lib/logs/
```
Expected: all tests PASS; tsc prints nothing; eslint exits clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/log-archive-store.ts src/lib/logs/log-archive-store.test.ts
git commit -m "feat(logs): readRange across day partitions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria for Phase A1

- `src/lib/logs/` contains `log-types.ts`, `log-archive-paths.ts`, `manifest.ts`, `log-index.ts`, `log-archive-store.ts` with co-located tests.
- `npx vitest run src/lib/logs/` is green; `tsc --noEmit` and `eslint` clean.
- The storage core can: partition by UTC day, dedup by `payload._id`, append NDJSON + index, merge covered ranges into a manifest, and read a time range back.
- No AIC network code, API routes, or UI yet — those are **Phase A2** (pull runner + job registry + API + minimal UI) and **Phase A3** (journey report reads the archive).

## Self-review notes (author)

- Spec coverage: storage layout ✓, day partitioning ✓, `payload._id` dedup ✓, manifest/covered-ranges ✓, derived-index/NDJSON-as-truth ✓. Rate-limit pacing, no-total progress, streaming, and gzip are **out of scope for A1** (pull runner = A2; gzip can be folded into A2/A3 once volumes are real).
- Placeholder scan: none — every step has full code.
- Type consistency: `LogIndexRow`, `RawLogEntry`, `LogArchiveManifest`, `appendEntries`/`readRange`/`extractRow`/`openDayDb`/`insertRows`/`queryDay` names are consistent across tasks.
