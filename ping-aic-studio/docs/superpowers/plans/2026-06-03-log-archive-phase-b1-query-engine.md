# Log Archive — Phase B1 (Query Engine + API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A filtered, paginated query over the local log archive — the backend for the "explore" layer — across day partitions and sources, served by an HTTP route.

**Architecture:** Extend the per-day SQLite index with timestamp-range + level filters and a count query, then add a `queryArchive` aggregator that opens the day-partition DBs overlapping a window for the requested sources, filters/counts via SQLite, merges results timestamp-ordered, and paginates (with a scan cap for safety). A thin `POST /api/logs/archive/query` route exposes it (env-allowlisted). The explore UI is the follow-up Phase B-ui.

**Tech Stack:** TypeScript, `better-sqlite3`, Vitest, Next.js route. Builds on A1 (`log-index`, `log-archive-paths`, `appendEntries`) and A2b conventions.

**Reference spec:** `docs/superpowers/specs/2026-06-03-log-archive-design.md` (explore UX = "Structured filters + reports").
**Builds on:** A1–A3 + A2c (archive populated + journey reads it).

---

## File Structure

- `src/lib/logs/log-index.ts` (MODIFY) — shared `buildWhere`, extend `LogQueryFilters` with `from`/`to`/`level`, add `countDay`.
- `src/lib/logs/log-query.ts` (CREATE) — `queryArchive(archiveRoot, query)` aggregator.
- `src/app/api/logs/archive/query/route.ts` (CREATE) — `POST` filtered query.
- `src/app/api/logs/archive/query/route.test.ts` (CREATE) — route test (mocked `queryArchive`).

---

## Task 1: Extend the per-day index with range/level filters + count

**Files:**
- Modify: `src/lib/logs/log-index.ts`
- Test: `src/lib/logs/log-index.test.ts`

- [ ] **Step 1: Write the failing tests** — add to `src/lib/logs/log-index.test.ts`:

```typescript
import { countDay } from "./log-index"; // merge into the existing import from "./log-index"

describe("log-index range/level filters + count", () => {
    function seed(db: ReturnType<typeof openDayDb>) {
        insertRows(db, [
            row({ id: "a", timestamp: "2026-06-02T01:00:00Z", level: "INFO", eventName: "AM-NODE-LOGIN-COMPLETED" }),
            row({ id: "b", timestamp: "2026-06-02T05:00:00Z", level: "ERROR", eventName: "AM-TREE-LOGIN-COMPLETED" }),
            row({ id: "c", timestamp: "2026-06-02T09:00:00Z", level: "INFO", eventName: "AM-TREE-LOGIN-COMPLETED" }),
        ]);
    }

    it("filters queryDay by timestamp range [from,to]", () => {
        const db = openDayDb(tmpDb());
        seed(db);
        const rows = queryDay(db, { from: "2026-06-02T02:00:00Z", to: "2026-06-02T06:00:00Z" });
        expect(rows.map((r) => r.id)).toEqual(["b"]);
        db.close();
    });

    it("filters queryDay by level", () => {
        const db = openDayDb(tmpDb());
        seed(db);
        expect(queryDay(db, { level: "ERROR" }).map((r) => r.id)).toEqual(["b"]);
        db.close();
    });

    it("supports offset for pagination (ordered by timestamp)", () => {
        const db = openDayDb(tmpDb());
        seed(db);
        expect(queryDay(db, { limit: 1, offset: 1 }).map((r) => r.id)).toEqual(["b"]);
        db.close();
    });

    it("countDay counts matches with the same filters (ignoring limit/offset)", () => {
        const db = openDayDb(tmpDb());
        seed(db);
        expect(countDay(db, {})).toBe(3);
        expect(countDay(db, { level: "INFO" })).toBe(2);
        expect(countDay(db, { from: "2026-06-02T02:00:00Z", to: "2026-06-02T23:00:00Z" })).toBe(2);
        db.close();
    });
});
```

(Merge `countDay` into the existing `import { ... } from "./log-index";` line. The existing `row()` helper already accepts `Partial<LogIndexRow>` overrides.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/logs/log-index.test.ts`
Expected: FAIL — `countDay` not exported; range/level/offset filters unsupported.

- [ ] **Step 3: Implement** — in `src/lib/logs/log-index.ts`, REPLACE the `LogQueryFilters` interface and `queryDay` function with:

```typescript
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
    const row = db.prepare(`SELECT COUNT(*) AS n FROM entries${whereSql}`).get(...params) as { n: number };
    return row.n;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/logs/log-index.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Gates**

```bash
npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"
npx eslint src/lib/logs/
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/log-index.ts src/lib/logs/log-index.test.ts
git commit -m "feat(logs): index range/level filters, offset pagination, countDay

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `queryArchive` aggregator

**Files:**
- Create: `src/lib/logs/log-query.ts`
- Test: `src/lib/logs/log-query.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/logs/log-query.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { appendEntries } from "./log-archive-store";
import { queryArchive } from "./log-query";
import type { RawLogEntry } from "./log-types";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-query-"));
}
function entry(id: string, ts: string, over: Record<string, unknown> = {}): RawLogEntry {
    return { timestamp: ts, source: "am-authentication", payload: { _id: id, eventName: "AM-NODE-LOGIN-COMPLETED", transactionId: "t1", level: "INFO", realm: "/alpha", principal: "alice", ...over } };
}

describe("queryArchive", () => {
    it("returns matching rows across day partitions, timestamp-ordered, with total", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z"),
            entry("b", "2026-06-02T23:30:00Z"),
            entry("c", "2026-06-03T00:30:00Z"),
        ]);
        const res = queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T12:00:00Z" });
        expect(res.total).toBe(3);
        expect(res.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
        expect(res.rows[0].source).toBe("am-authentication");
        expect(res.capped).toBe(false);
    });

    it("applies eventName/level/text filters", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z", { eventName: "AM-TREE-LOGIN-COMPLETED", level: "ERROR" }),
            entry("b", "2026-06-02T02:00:00Z", { eventName: "AM-NODE-LOGIN-COMPLETED", level: "INFO" }),
        ]);
        expect(queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", level: "ERROR" }).rows.map((r) => r.id)).toEqual(["a"]);
        expect(queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", eventName: "AM-NODE-LOGIN-COMPLETED" }).rows.map((r) => r.id)).toEqual(["b"]);
    });

    it("paginates with offset/limit while reporting the full total", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [
            entry("a", "2026-06-02T01:00:00Z"),
            entry("b", "2026-06-02T02:00:00Z"),
            entry("c", "2026-06-02T03:00:00Z"),
        ]);
        const res = queryArchive(root, { sources: ["am-authentication"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z", offset: 1, limit: 1 });
        expect(res.total).toBe(3);
        expect(res.rows.map((r) => r.id)).toEqual(["b"]);
    });

    it("merges multiple sources timestamp-ordered and skips absent sources", () => {
        const root = tmpRoot();
        appendEntries(root, "am-authentication", [entry("a", "2026-06-02T01:00:00Z")]);
        appendEntries(root, "am-access", [{ timestamp: "2026-06-02T01:30:00Z", source: "am-access", payload: { _id: "x", eventName: "AM-ACCESS", transactionId: "t9", level: "INFO", realm: "/alpha" } }]);
        const res = queryArchive(root, { sources: ["am-authentication", "am-access", "idm-activity"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" });
        expect(res.rows.map((r) => `${r.source}:${r.id}`)).toEqual(["am-authentication:a", "am-access:x"]);
        expect(res.total).toBe(2);
    });

    it("returns empty when nothing is archived", () => {
        const root = tmpRoot();
        const res = queryArchive(root, { sources: ["am-core"], from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" });
        expect(res).toEqual({ total: 0, rows: [], capped: false });
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/logs/log-query.test.ts`
Expected: FAIL — Cannot find module './log-query'.

- [ ] **Step 3: Implement** — `src/lib/logs/log-query.ts`:

```typescript
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/logs/log-query.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Gates**

```bash
npx vitest run src/lib/logs/
npx tsc --noEmit 2>&1 | grep -i "logs/" || echo "no logs type errors"
npx eslint src/lib/logs/
```
Expected: all logs tests pass; clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logs/log-query.ts src/lib/logs/log-query.test.ts
git commit -m "feat(logs): queryArchive — filtered, paginated multi-day/source query

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Query API route

**Files:**
- Create: `src/app/api/logs/archive/query/route.ts`
- Test: `src/app/api/logs/archive/query/route.test.ts`

- [ ] **Step 1: Write the failing test** — `src/app/api/logs/archive/query/route.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/fr-config", () => ({
    getEnvironments: () => [{ name: "prod" }],
}));
const queryArchiveMock = vi.fn(() => ({ total: 2, rows: [{ id: "a" }, { id: "b" }], capped: false }));
vi.mock("@/lib/logs/log-query", () => ({ queryArchive: (...args: unknown[]) => queryArchiveMock(...args) }));

import { POST } from "./route";

function req(body: unknown) {
    return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

describe("archive query route", () => {
    it("400s on unknown environment", async () => {
        const res = await POST(req({ env: "nope", from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z" }));
        expect(res.status).toBe(400);
    });

    it("400s when from/to missing", async () => {
        const res = await POST(req({ env: "prod" }));
        expect(res.status).toBe(400);
    });

    it("runs queryArchive and returns its result", async () => {
        const res = await POST(req({
            env: "prod", from: "2026-06-02T00:00:00Z", to: "2026-06-03T00:00:00Z",
            sources: ["am-authentication"], eventName: "AM-TREE-LOGIN-COMPLETED", limit: 50,
        }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ total: 2, capped: false });
        expect(body.rows).toHaveLength(2);
        // queryArchive received the filters
        const call = queryArchiveMock.mock.calls[0][1] as Record<string, unknown>;
        expect(call).toMatchObject({ sources: ["am-authentication"], eventName: "AM-TREE-LOGIN-COMPLETED", limit: 50 });
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/logs/archive/query/route.test.ts`
Expected: FAIL — Cannot find module './route'.

- [ ] **Step 3: Implement** — `src/app/api/logs/archive/query/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { logDataDir } from "@/lib/logs/log-archive-paths";
import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";
import { queryArchive } from "@/lib/logs/log-query";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(DEFAULT_LOG_SOURCES);

/**
 * Filtered, paginated read over the local log archive.
 * Body: { env, from, to, sources?, eventName?, transactionId?, userId?, level?, text?, offset?, limit? }
 */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    const env = typeof body.env === "string" ? body.env : "";
    const from = typeof body.from === "string" ? body.from : "";
    const to = typeof body.to === "string" ? body.to : "";

    if (!env || !from || !to) {
        return NextResponse.json({ error: "env, from, and to are required." }, { status: 400 });
    }
    if (!getEnvironments().some((e) => e.name === env)) {
        return NextResponse.json({ error: "unknown environment" }, { status: 400 });
    }

    let sources: string[] = Array.isArray(body.sources)
        ? body.sources.filter((s: unknown): s is string => typeof s === "string")
        : [];
    if (sources.length === 0) sources = [...DEFAULT_LOG_SOURCES];
    const invalid = sources.filter((s) => !ALLOWED.has(s));
    if (invalid.length) {
        return NextResponse.json({ error: `unsupported sources: ${invalid.join(", ")}` }, { status: 400 });
    }

    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const numOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

    const result = queryArchive(logDataDir(env), {
        sources,
        from,
        to,
        eventName: str(body.eventName),
        transactionId: str(body.transactionId),
        userId: str(body.userId),
        level: str(body.level),
        text: str(body.text),
        offset: numOr(body.offset, 0),
        limit: numOr(body.limit, 100),
    });

    return NextResponse.json(result);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/app/api/logs/archive/query/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Gates**

```bash
npx tsc --noEmit
npx eslint src/app/api/logs/archive/
npx vitest run
```
Expected: `tsc` clean; eslint clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/logs/archive/query/route.ts src/app/api/logs/archive/query/route.test.ts
git commit -m "feat(logs): archive query API route (filtered, paginated, env-allowlisted)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria for Phase B1

- `queryDay`/`countDay` support eventName, transactionId, userId, level, timestamp range, free-text, limit, offset (unit-tested).
- `queryArchive` aggregates across day partitions + sources, returns exact total + timestamp-ordered page + capped flag (unit-tested).
- `POST /api/logs/archive/query` validates + allowlists env/sources and returns the query result (route-tested).
- Full Vitest suite green; `tsc --noEmit` + `eslint` clean.

## Manual smoke test

```bash
curl -s -X POST localhost:3000/api/logs/archive/query -H 'content-type: application/json' \
  -d '{"env":"prod","sources":["am-authentication"],"from":"2026-06-02T00:00:00Z","to":"2026-06-03T00:00:00Z","eventName":"AM-TREE-LOGIN-COMPLETED","limit":20}' | jq '{total, capped, n: (.rows|length)}'
```
(Requires a prior pull for the window.)

## Self-review notes (author)

- **Spec coverage (B explore backend):** filter by source/time/transaction/event/user/level/text ✓; pagination + total ✓; multi-source ✓; env+source allowlist ✓. The explore **UI** (filters + results table + drill-down) is the follow-up **Phase B-ui**; prebuilt reports beyond the journey report (already A3) are future.
- **Placeholder scan:** none.
- **Type consistency:** `LogQueryFilters` (extended) ↔ `queryDay`/`countDay` ↔ `queryArchive`'s `ArchiveQuery`/`ArchiveQueryResult`; route maps body → `ArchiveQuery`; `DEFAULT_LOG_SOURCES`/`logDataDir`/`getEnvironments` reused.
- **Known cap:** results materialize up to `MAX_SCAN` (50k) before pagination; `total` stays exact via per-day COUNT; `capped` signals when deep pages past the cap aren't available — the UI should surface "refine filters". Acceptable for a filtered explorer; a SQL-level merge cursor is a future optimization.
```
