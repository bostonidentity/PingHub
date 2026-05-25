# Records SQLite Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the data-browse list responsive on multi-million-record managed types by replacing the in-memory `_index.json` cache with a per-type embedded SQLite database, so list/search/read operations cost O(log n) disk instead of O(n) memory.

**Architecture:** Each managed-type directory (`environments/<env>/managed-data/<type>/`) gets an `index.sqlite` file alongside the existing `data.ndjson`. The DB holds one row per record with: id (PK), pull-order, byte offset+length into the NDJSON, the indexed scalar fields as JSON, and a lowercased `searchable` text column used for substring `LIKE '%q%'` search. The pull runner writes rows in transaction-batched inserts as it streams NDJSON pages (no in-memory accumulator). Readers (`snapshot-fs.ts`) prefer SQLite when present and lazily build it from `data.ndjson` on first read if missing — so existing pulled snapshots keep working with a one-time backfill. The legacy `_index.json` and `_offsets.json` are no longer written; legacy per-`{id}.json` directories continue to work via the existing fallback path. SQLite is embedded (`better-sqlite3`) — no daemon, no external service.

**Tech stack:** Next.js (App Router), TypeScript, React 19, Vitest, `better-sqlite3` (new). The repo's `aic-pipeline/AGENTS.md` warns Next.js APIs may differ from training data — read `aic-pipeline/node_modules/next/dist/docs/` before touching Next.js APIs. Tests run with `npx vitest run <path>` (single file) or `npm test` (full suite). All file paths below are relative to `aic-pipeline/` unless prefixed with `aic-pipeline/`.

**Spec:** none — this plan's Architecture section is the spec. No separate design doc was produced for this work.

**Out of scope:**
- `_refs.json` — kept as-is. Migrating refs to SQLite is a separate concern.
- Legacy per-`{id}.json` directories — keep the existing fallback path; do not auto-migrate them.
- Trigram / FTS5 indexes — Phase 2 if `LIKE '%q%'` proves too slow. The plan uses `LIKE` for semantic parity with today.
- Frontend changes — `BrowsePanel.tsx` and `useSnapshotRecords.ts` keep their current API.

---

## File map

**New files:**
- `src/lib/data/index-db.ts` — SQLite open/init helper; per-directory connection cache keyed by manifest `pulledAt`.
- `src/lib/data/index-db.test.ts` — schema unit tests.
- `src/lib/data/index-builder.ts` — `buildIndexFromNDJson(dir, pickIndexFields)`; reads `data.ndjson` line-by-line, populates SQLite in one transaction.
- `src/lib/data/index-builder.test.ts` — indexer unit tests.

**Modified files:**
- `package.json` — add `better-sqlite3` and `@types/better-sqlite3`.
- `src/lib/data/pull-runner.ts` — replace in-memory `offsets` / `indexEntries` accumulators with incremental SQLite inserts (batched per page). Stop writing `_index.json` and `_offsets.json`. Keep `_manifest.json` and `_refs.json` writes.
- `src/lib/data/snapshot-fs.ts` — `loadCache` opens the SQLite DB (lazy-backfills if missing); `listRecords` and `readRecord` switch to SQL queries; legacy `_index.json` reading and the in-memory caches are removed for the NDJSON path. Legacy per-`{id}.json` path is unchanged.
- `src/lib/data/snapshot-fs.test.ts` — fixtures updated to write `index.sqlite` instead of `_index.json` / `_offsets.json`.
- `src/lib/data/pull-runner.test.ts` — update on-disk shape assertions (no `_index.json`, no `_offsets.json`; expect `index.sqlite`); add a resume-after-crash assertion that the SQLite DB is repopulated.

---

## Task 1: Add `better-sqlite3` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the runtime + types.**

Run:
```bash
cd aic-pipeline && npm install --save better-sqlite3 && npm install --save-dev @types/better-sqlite3
```
Expected: both packages resolve and a prebuilt native binding is downloaded for the current platform. If the prebuilt is unavailable, `npm install` falls back to compiling — that needs `python3` and a C++ toolchain on the host.

- [ ] **Step 2: Sanity-check the import.**

Run:
```bash
cd aic-pipeline && node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); d.prepare('CREATE TABLE t(x)').run(); console.log('ok');"
```
Expected: prints `ok`.

- [ ] **Step 3: Commit.**

```bash
git add aic-pipeline/package.json aic-pipeline/package-lock.json
git commit -m "build(deps): add better-sqlite3 for managed-data index"
```

---

## Task 2: SQLite schema + connection module

**Files:**
- Create: `src/lib/data/index-db.ts`
- Test: `src/lib/data/index-db.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `src/lib/data/index-db.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { openIndexDb, INDEX_DB_FILE, SCHEMA_VERSION } from "./index-db";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idx-db-"));
}

describe("index-db", () => {
  it("creates schema on first open", () => {
    const dir = tmpDir();
    const db = openIndexDb(dir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["meta", "records"]);
    const v = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    db.close();
    expect(fs.existsSync(path.join(dir, INDEX_DB_FILE))).toBe(true);
  });

  it("reuses an existing DB without re-creating tables", () => {
    const dir = tmpDir();
    const a = openIndexDb(dir);
    a.prepare("INSERT INTO meta(key,value) VALUES ('mark','x')").run();
    a.close();
    const b = openIndexDb(dir);
    const row = b.prepare("SELECT value FROM meta WHERE key='mark'").get() as { value: string };
    expect(row.value).toBe("x");
    b.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/index-db.test.ts`
Expected: FAIL — `Cannot find module './index-db'`.

- [ ] **Step 3: Create the module.**

Create `src/lib/data/index-db.ts`:
```ts
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
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/index-db.test.ts`
Expected: PASS, both cases green.

- [ ] **Step 5: Commit.**

```bash
git add aic-pipeline/src/lib/data/index-db.ts aic-pipeline/src/lib/data/index-db.test.ts
git commit -m "feat(data): add per-type SQLite index schema + open helper"
```

---

## Task 3: Index builder — NDJSON → SQLite

**Files:**
- Create: `src/lib/data/index-builder.ts`
- Test: `src/lib/data/index-builder.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `src/lib/data/index-builder.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { buildIndexFromNDJson } from "./index-builder";
import { openIndexDb } from "./index-db";
import { NDJSON_FILE } from "./ndjson-format";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idx-build-"));
}

function pickFields(r: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

function writeNDJson(dir: string, lines: object[]): void {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, NDJSON_FILE), text);
}

describe("buildIndexFromNDJson", () => {
  it("populates rows with correct offset, length, fields_json, searchable", async () => {
    const dir = tmpDir();
    writeNDJson(dir, [
      { _id: "a", userName: "Alice", givenName: "A" },
      { _id: "b", userName: "Bob", givenName: "B" },
    ]);
    const n = await buildIndexFromNDJson(dir, pickFields);
    expect(n).toBe(2);

    const db = openIndexDb(dir);
    const rows = db.prepare("SELECT id, ord, offset, length, fields_json, searchable FROM records ORDER BY ord").all() as Array<{
      id: string; ord: number; offset: number; length: number; fields_json: string; searchable: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("a");
    expect(rows[0].ord).toBe(0);
    expect(rows[0].offset).toBe(0);
    expect(rows[0].length).toBe(JSON.stringify({ _id: "a", userName: "Alice", givenName: "A" }).length);
    expect(JSON.parse(rows[0].fields_json)).toEqual({ _id: "a", userName: "Alice", givenName: "A" });
    expect(rows[0].searchable).toContain("alice");
    expect(rows[1].offset).toBe(rows[0].length + 1); // +1 for the newline
    db.close();
  });

  it("is idempotent — second call truncates and rebuilds", async () => {
    const dir = tmpDir();
    writeNDJson(dir, [{ _id: "a", userName: "A" }]);
    await buildIndexFromNDJson(dir, pickFields);
    writeNDJson(dir, [{ _id: "x", userName: "X" }, { _id: "y", userName: "Y" }]);
    const n = await buildIndexFromNDJson(dir, pickFields);
    expect(n).toBe(2);

    const db = openIndexDb(dir);
    const ids = (db.prepare("SELECT id FROM records ORDER BY ord").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["x", "y"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/index-builder.test.ts`
Expected: FAIL — `Cannot find module './index-builder'`.

- [ ] **Step 3: Implement the builder.**

Create `src/lib/data/index-builder.ts`:
```ts
import fs from "fs";
import path from "path";
import readline from "readline";
import { openIndexDb } from "./index-db";
import { NDJSON_FILE } from "./ndjson-format";

export type PickIndexFields = (record: Record<string, unknown>) => Record<string, string>;

interface Row {
  id: string;
  ord: number;
  offset: number;
  length: number;
  fields_json: string;
  searchable: string;
}

/**
 * Build (or rebuild) `index.sqlite` in `typeDir` from `data.ndjson`.
 *
 * Streams the NDJSON line-by-line; each line is one record. Inserts are
 * wrapped in a single transaction for throughput (~50× faster than autocommit
 * on better-sqlite3). Returns the number of rows inserted.
 *
 * Idempotent: existing rows are deleted before insertion. Safe to call to
 * recover from a partial pull.
 */
export async function buildIndexFromNDJson(
  typeDir: string,
  pickIndexFields: PickIndexFields,
): Promise<number> {
  const ndjsonPath = path.join(typeDir, NDJSON_FILE);
  if (!fs.existsSync(ndjsonPath)) return 0;

  // Stream NDJSON to collect rows. The whole row set fits in memory because
  // each row is just id + offset + length + scalar-fields JSON — small even
  // for millions of records (< 1 GB at 5M rows).
  const rows: Row[] = [];
  const stream = fs.createReadStream(ndjsonPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let offset = 0;
  let ord = 0;
  for await (const line of rl) {
    if (!line) {
      offset += 1; // empty line is just the newline
      continue;
    }
    const length = Buffer.byteLength(line, "utf-8");
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const id = typeof r._id === "string" ? r._id : "";
      if (id) {
        const fields = pickIndexFields(r);
        rows.push({
          id,
          ord,
          offset,
          length,
          fields_json: JSON.stringify(fields),
          searchable: Object.values(fields).join(" ").toLowerCase(),
        });
        ord++;
      }
    } catch { /* skip malformed line */ }
    offset += length + 1; // +1 for the newline separator
  }
  rl.close();
  stream.destroy();

  const db = openIndexDb(typeDir);
  try {
    db.prepare("DELETE FROM records").run();
    const insert = db.prepare(
      "INSERT INTO records(id, ord, offset, length, fields_json, searchable) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertAll = db.transaction((batch: Row[]) => {
      for (const r of batch) {
        insert.run(r.id, r.ord, r.offset, r.length, r.fields_json, r.searchable);
      }
    });
    insertAll(rows);
    return rows.length;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/index-builder.test.ts`
Expected: PASS, both cases green.

- [ ] **Step 5: Commit.**

```bash
git add aic-pipeline/src/lib/data/index-builder.ts aic-pipeline/src/lib/data/index-builder.test.ts
git commit -m "feat(data): add NDJSON to SQLite index builder"
```

---

## Task 4: Pull runner writes SQLite incrementally; stops writing legacy index/offsets

**Files:**
- Modify: `src/lib/data/pull-runner.ts`
- Modify: `src/lib/data/pull-runner.test.ts`

The current code accumulates `offsets`, `indexEntries`, `refsIndex` in memory and writes three JSON files at the end. After this task, `offsets` and `indexEntries` are removed entirely; per-page batched SQLite inserts replace them.

- [ ] **Step 1: Update test fixtures and assertions.**

Open `src/lib/data/pull-runner.test.ts`. Find every assertion that checks for `_index.json` or `_offsets.json` and replace it with an assertion against `index.sqlite`. Concretely:

Replace all occurrences of:
```ts
expect(fs.existsSync(path.join(typeDir, "_index.json"))).toBe(true);
```
with:
```ts
expect(fs.existsSync(path.join(typeDir, "index.sqlite"))).toBe(true);
```

Replace all occurrences of:
```ts
expect(fs.existsSync(path.join(typeDir, "_offsets.json"))).toBe(true);
```
with:
```ts
// _offsets.json is no longer written; offsets live in index.sqlite.
expect(fs.existsSync(path.join(typeDir, "_offsets.json"))).toBe(false);
```

Find any test that reads `_index.json` and asserts on its contents. Rewrite that block to query `index.sqlite` instead, e.g.:
```ts
import Database from "better-sqlite3";
const db = new Database(path.join(typeDir, "index.sqlite"), { readonly: true });
const rows = db.prepare("SELECT id, fields_json FROM records ORDER BY ord").all() as { id: string; fields_json: string }[];
db.close();
expect(rows.map((r) => r.id)).toEqual(["alice", "bob"]); // adjust to fixture
```

- [ ] **Step 2: Run the tests to confirm they fail (still writing legacy files).**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts`
Expected: FAIL — assertions on `index.sqlite` existing fail.

- [ ] **Step 3: Add SQLite imports and remove legacy offset imports in `pull-runner.ts`.**

At the top of `src/lib/data/pull-runner.ts`, replace the existing imports block (lines 1–6) with:

```ts
import fs from "fs";
import path from "path";
import readline from "readline";
import type { DataPullJob } from "./types";
import type { Registry } from "./job-registry";
import { NDJSON_FILE } from "./ndjson-format";
import { openIndexDb } from "./index-db";
import { buildIndexFromNDJson } from "./index-builder";
import type Database from "better-sqlite3";
```

Note: `OFFSETS_FILE` and `Offsets` are removed from imports — they're no longer used. Verify by grepping after the edit:
```bash
grep -n "OFFSETS_FILE\|Offsets\b" aic-pipeline/src/lib/data/pull-runner.ts
```
Expected: no matches.

- [ ] **Step 4: Replace the in-memory accumulators with a SQLite handle, prepared statement, and a `seenIds` set.**

Find the block (around lines 218–220):
```ts
    let indexEntries: { id: string; f: Record<string, string> }[] = [];
    let refsIndex: Record<string, string[]> = {};
    let offsets: Offsets = {};
```

Replace with:
```ts
    let refsIndex: Record<string, string[]> = {};
    /** Bytes already written to data.ndjson — used as the offset for the next record. */
    let bytesWritten = 0;
    /** Set of ids already inserted. Replaces the legacy `id in offsets` dedupe. */
    const seenIds = new Set<string>();
```

Find the resume block at lines ~256–259:
```ts
      offsets = rebuilt.offsets;
      indexEntries = rebuilt.indexEntries;
      refsIndex = rebuilt.refsIndex;
```

Replace with:
```ts
      refsIndex = rebuilt.refsIndex;
      for (const id of Object.keys(rebuilt.offsets)) seenIds.add(id);
      bytesWritten = rebuilt.byteLength;
```

(`rebuilt` keeps its legacy shape because `rebuildFromNDJson` is unchanged in this task — its outputs feed `seenIds` and `bytesWritten` here.)

- [ ] **Step 5: Open the SQLite DB inside the per-type loop.**

Inside the per-type loop, immediately after `typePullingDir` is created and `ndjsonStream` is opened (search for `const ndjsonStream =` — it's the line that opens the write stream), add:

```ts
    const indexDb: Database.Database = openIndexDb(typePullingDir);
    indexDb.prepare("DELETE FROM records").run(); // resume case — idempotent rebuild
    const insertStmt = indexDb.prepare(
      "INSERT OR REPLACE INTO records(id, ord, offset, length, fields_json, searchable) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let nextOrd = 0; // restarts from 0; the post-pull buildIndexFromNDJson re-numbers from disk truth
```

The resume path now relies on a final `buildIndexFromNDJson` call after the pull completes (Step 7). During the pull itself we only insert newly-fetched rows; rebuilt-but-not-yet-inserted rows from a prior crash get re-indexed at the end from disk. This keeps the per-page hot path simple.

- [ ] **Step 6: Replace the per-record write block with batched SQLite inserts.**

Find the block at lines ~344–361:
```ts
          const items = data.result ?? [];
          for (const item of items) {
            if (signal.aborted) { ndjsonStream.destroy(); break outer; }
            const id = typeof item._id === "string"
              ? item._id
              : typeof item.id === "string"
                ? item.id as string
                : String(fetched + 1);
            if (id in offsets) continue; // dedupe on resume
            const line = JSON.stringify(item) + "\n";
            offsets[id] = bytesWritten;
            ndjsonStream.write(line);
            bytesWritten += Buffer.byteLength(line, "utf-8");
            indexEntries.push({ id, f: pickIndexFields(item) });
            const itemRefs = extractRefs(item);
            if (itemRefs.length > 0) refsIndex[id] = itemRefs;
            fetched++;
          }
```

Replace with:
```ts
          const items = data.result ?? [];
          // Build the page's index rows first so the SQLite insert can run in
          // a single transaction (~50× faster than autocommit on better-sqlite3).
          interface PageRow { id: string; ord: number; offset: number; length: number; fields_json: string; searchable: string; line: string; refs: string[]; }
          const pageRows: PageRow[] = [];
          for (const item of items) {
            if (signal.aborted) { ndjsonStream.destroy(); break outer; }
            const id = typeof item._id === "string"
              ? item._id
              : typeof item.id === "string"
                ? item.id as string
                : String(fetched + 1);
            if (seenIds.has(id)) continue; // dedupe on resume
            const lineStr = JSON.stringify(item);
            const lineLen = Buffer.byteLength(lineStr, "utf-8");
            const fields = pickIndexFields(item);
            pageRows.push({
              id,
              ord: nextOrd,
              offset: bytesWritten,
              length: lineLen,
              fields_json: JSON.stringify(fields),
              searchable: Object.values(fields).join(" ").toLowerCase(),
              line: lineStr,
              refs: extractRefs(item),
            });
            seenIds.add(id);
            nextOrd++;
            bytesWritten += lineLen + 1; // +1 for newline
          }
          // NDJSON write goes outside the transaction (different file/handle).
          for (const r of pageRows) ndjsonStream.write(r.line + "\n");
          // SQLite inserts in one transaction.
          const insertPage = indexDb.transaction((batch: PageRow[]) => {
            for (const r of batch) {
              insertStmt.run(r.id, r.ord, r.offset, r.length, r.fields_json, r.searchable);
            }
          });
          insertPage(pageRows);
          for (const r of pageRows) {
            if (r.refs.length > 0) refsIndex[r.id] = r.refs;
            fetched++;
          }
```

- [ ] **Step 7: Replace the legacy `_index.json` / `_offsets.json` writes with a final SQLite consistency pass.**

Find the post-swap write block (lines ~437–453):
```ts
      const pulledAt = Date.now();
      fs.writeFileSync(
        path.join(currentDir, "_manifest.json"),
        JSON.stringify({ type, pulledAt, count: fetched, jobId: job.id }, null, 2),
      );
      fs.writeFileSync(
        path.join(currentDir, "_index.json"),
        JSON.stringify(indexEntries),
      );
      fs.writeFileSync(
        path.join(currentDir, "_refs.json"),
        JSON.stringify(refsIndex),
      );
      fs.writeFileSync(
        path.join(currentDir, OFFSETS_FILE),
        JSON.stringify(offsets),
      );
```

Replace with:
```ts
      const pulledAt = Date.now();
      fs.writeFileSync(
        path.join(currentDir, "_manifest.json"),
        JSON.stringify({ type, pulledAt, count: fetched, jobId: job.id }, null, 2),
      );
      fs.writeFileSync(
        path.join(currentDir, "_refs.json"),
        JSON.stringify(refsIndex),
      );
      // Rebuild SQLite from the now-canonical data.ndjson. Cheap because reading
      // is sequential and inserts go in one transaction. Also covers the resume
      // case where rebuilt-but-not-inserted rows existed at the start of the run.
      indexDb.close();
      await buildIndexFromNDJson(currentDir, pickIndexFields);
      // Mirror manifest pulledAt into meta for parity.
      const finalDb = openIndexDb(currentDir);
      finalDb.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('pulledAt', ?)").run(String(pulledAt));
      finalDb.close();
```

Also: ensure `indexDb` is closed on the failure paths. Find the type-failed block (around line 414) and add `indexDb.close();` next to `ndjsonStream.destroy();`. Same for the abort block (around line 408).

- [ ] **Step 8: Verify pull-runner.ts compiles.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Run the pull-runner tests.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts`
Expected: PASS. If a test asserts on `_index.json` contents that was missed in Step 1, fix it now using a SQLite query.

- [ ] **Step 10: Commit.**

```bash
git add aic-pipeline/src/lib/data/pull-runner.ts aic-pipeline/src/lib/data/pull-runner.test.ts
git commit -m "feat(pull): write SQLite index incrementally; drop _index.json/_offsets.json writes"
```

---

## Task 5: Read path — `loadCache` becomes a SQLite-handle cache with lazy backfill

**Files:**
- Modify: `src/lib/data/snapshot-fs.ts`

The current `loadCache(dir)` (lines 53–133) loads `_index.json`, `_offsets.json`, all ids, and a sampled fields set into memory. After this task it returns a connection handle and metadata only — O(1) RAM.

- [ ] **Step 1: Replace the imports block at the top of `snapshot-fs.ts`.**

Replace lines 1–7 with:
```ts
import fs from "fs";
import { existsSync } from "fs";
import fsp from "fs/promises";
import readline from "readline";
import path from "path";
import type Database from "better-sqlite3";
import type { DisplayFields, SnapshotType, SnapshotRecordPage } from "./types";
import { isNDJsonFormat, NDJSON_FILE } from "./ndjson-format";
import { openIndexDb } from "./index-db";
import { buildIndexFromNDJson, type PickIndexFields } from "./index-builder";
```

(`OFFSETS_FILE` and `Offsets` are no longer needed.)

- [ ] **Step 2: Replace the `IndexEntry` and `TypeCache` types and the in-memory `cache`.**

Replace lines 13–44 (the `IndexEntry` interface, `TypeCache` interface, `cache` map, and `pending` map) with:
```ts
/**
 * Per-directory cached SQLite handle. Key = typeDir. Invalidated when the
 * manifest's `pulledAt` differs from `pulledAt` recorded here at open time —
 * a new pull writes a new `index.sqlite` plus a new `_manifest.json`.
 */
interface TypeCache {
  pulledAt: number;
  /** Open `index.sqlite` connection. */
  db: Database.Database;
  /** Indexed scalar field names — derived once from a single SQLite query. */
  fields: string[];
}

const cache = new Map<string, TypeCache>();
const pending = new Map<string, Promise<TypeCache>>();

/**
 * Bridge function for the lazy-backfill path. The pull runner uses its own
 * picker; this duplicates the rule (short scalar fields only, skip underscore
 * keys except _id, length cap 200) so the read path can rebuild a missing
 * SQLite DB without importing pull-runner internals.
 */
const INDEX_FIELD_MAX_LEN = 200;
const pickIndexFieldsForBackfill: PickIndexFields = (record) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith("_") && k !== "_id") continue;
    if (typeof v === "string" && v.length <= INDEX_FIELD_MAX_LEN) out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
};
```

- [ ] **Step 3: Rewrite `loadCache`.**

Replace the entire body of `loadCache` (lines 53–133) with:
```ts
async function loadCache(dir: string): Promise<TypeCache> {
  const pulledAt = await getManifestPulledAt(dir);
  const existing = cache.get(dir);
  if (existing && existing.pulledAt === pulledAt) return existing;

  const inflight = pending.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    if (existing) {
      try { existing.db.close(); } catch { /* ignore */ }
      cache.delete(dir);
    }

    const dbPath = path.join(dir, "index.sqlite");
    // Lazy backfill: existing snapshots from before SQLite was introduced
    // have data.ndjson but no index.sqlite. Build it once on first read.
    if (!existsSync(dbPath) && existsSync(path.join(dir, NDJSON_FILE))) {
      await buildIndexFromNDJson(dir, pickIndexFieldsForBackfill);
    }

    const db = openIndexDb(dir);
    // Derive field list from a sample of fields_json — same shape as before.
    const sampleRows = db.prepare(
      "SELECT fields_json FROM records ORDER BY ord LIMIT ?",
    ).all(FIELD_SAMPLE_SIZE) as { fields_json: string }[];
    const fieldSet = new Set<string>();
    for (const row of sampleRows) {
      try {
        for (const k of Object.keys(JSON.parse(row.fields_json) as Record<string, unknown>)) {
          fieldSet.add(k);
        }
      } catch { /* skip malformed */ }
    }
    const entry: TypeCache = { pulledAt, db, fields: [...fieldSet].sort() };
    cache.set(dir, entry);
    return entry;
  })();

  pending.set(dir, work);
  try { return await work; } finally { pending.delete(dir); }
}
```

- [ ] **Step 4: Update `evictCache` to close the DB handle.**

Replace `evictCache` (lines 383–385) with:
```ts
export function evictCache(dir: string): void {
  const entry = cache.get(dir);
  if (entry) {
    try { entry.db.close(); } catch { /* ignore */ }
    cache.delete(dir);
  }
}
```

- [ ] **Step 5: Compile-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: errors only inside `listRecords` / `readRecord` (they still reference the removed `ids`, `index`, `offsets`, `ndjson` cache fields). Those are fixed in Tasks 6–8.

No commit yet — `listRecords` still uses removed fields. Continue to Task 6.

---

## Task 6: `listRecords` no-search path via SQLite

**Files:**
- Modify: `src/lib/data/snapshot-fs.ts`

- [ ] **Step 1: Replace the no-search branch in `listRecords`.**

Find the block in `listRecords` from `const tc = await loadCache(dir);` (line 244) through the end of the no-search branch — it covers lines ~244–278 today. Replace with:

```ts
  const q = opts.q.trim().toLowerCase();
  const tc = await loadCache(dir);
  const { db, fields } = tc;
  const titleField = opts.titleField ?? opts.display.title;
  const start = (opts.page - 1) * opts.limit;

  if (!q) {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c;
    const rows = db.prepare(
      "SELECT id, fields_json FROM records ORDER BY ord LIMIT ? OFFSET ?",
    ).all(opts.limit, start) as { id: string; fields_json: string }[];
    const records = rows.map((r) => {
      const f = JSON.parse(r.fields_json) as Record<string, string>;
      const key = findKeyCI(f, titleField);
      const title = (key && f[key]) || r.id;
      return { id: r.id, title };
    });
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }
```

- [ ] **Step 2: Compile-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: search-branch errors remain (still references `ids`, `index`, `ndjson`); no-search branch is clean. Continue to Task 7.

---

## Task 7: `listRecords` search path via SQLite `LIKE`

**Files:**
- Modify: `src/lib/data/snapshot-fs.ts`

- [ ] **Step 1: Replace the search branch in `listRecords`.**

Find the search branch — the block starting with `// Search path.` and ending at the end of `listRecords` (lines ~280–341). Replace with:

```ts
  // Search path — substring LIKE on the precomputed lowercased `searchable`
  // column. Same semantics as the legacy String.includes() comparison.
  const like = `%${q.replace(/[\\_%]/g, (c) => `\\${c}`)}%`;
  const total = (db.prepare(
    "SELECT COUNT(*) AS c FROM records WHERE searchable LIKE ? ESCAPE '\\'",
  ).get(like) as { c: number }).c;
  const rows = db.prepare(
    "SELECT id, fields_json FROM records WHERE searchable LIKE ? ESCAPE '\\' ORDER BY ord LIMIT ? OFFSET ?",
  ).all(like, opts.limit, start) as { id: string; fields_json: string }[];
  const records = rows.map((r) => {
    const f = JSON.parse(r.fields_json) as Record<string, string>;
    const key = findKeyCI(f, titleField);
    const title = (key && f[key]) || r.id;
    return { id: r.id, title };
  });
  return { total, page: opts.page, limit: opts.limit, fields, records };
}
```

(The closing `}` belongs to `listRecords`. Make sure no lines from the old search branches survive — search the file for `readTitlesFromNDJson` and `readTitleFromFile` afterward; both helpers are now unused and can be deleted.)

- [ ] **Step 2: Delete the now-unused helpers.**

Delete `readTitlesFromNDJson` (lines 343–366) and `readTitleFromFile` (lines 368–380) entirely. They're no longer referenced.

Verify by grep:
```bash
grep -n "readTitlesFromNDJson\|readTitleFromFile" aic-pipeline/src/lib/data/snapshot-fs.ts
```
Expected: no matches.

- [ ] **Step 3: Compile-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: errors only inside `readRecord` (still references `OFFSETS_FILE`). Fixed in Task 8.

---

## Task 8: `readRecord` uses SQLite for offset lookup

**Files:**
- Modify: `src/lib/data/snapshot-fs.ts`

- [ ] **Step 1: Rewrite `readRecord` and `readRecordFromNDJson`.**

Replace `readRecord` (lines 157–173) and `readRecordFromNDJson` (lines 175–211) with:

```ts
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
  const tc = await loadCache(typeDir);
  const row = tc.db.prepare(
    "SELECT offset, length FROM records WHERE id = ?",
  ).get(id) as { offset: number; length: number } | undefined;
  if (!row) return null;

  const ndjsonPath = path.join(typeDir, NDJSON_FILE);
  const fd = await fsp.open(ndjsonPath, "r");
  try {
    const buf = Buffer.alloc(row.length);
    await fd.read(buf, 0, row.length, row.offset);
    try { return JSON.parse(buf.toString("utf-8")) as Record<string, unknown>; }
    catch { return null; }
  } finally {
    await fd.close();
  }
}
```

- [ ] **Step 2: Compile-check the whole file.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the snapshot-fs tests.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts`
Expected: tests fail because fixtures still write `_index.json`/`_offsets.json` instead of `index.sqlite`. Fixed in Task 9.

---

## Task 9: Update `snapshot-fs.test.ts` fixtures

**Files:**
- Modify: `src/lib/data/snapshot-fs.test.ts`

- [ ] **Step 1: Identify fixture-writing helpers.**

Run:
```bash
grep -n "_index\.json\|_offsets\.json\|writeFileSync\|writeFile\b" aic-pipeline/src/lib/data/snapshot-fs.test.ts | head -40
```
This locates every fixture builder that needs updating.

- [ ] **Step 2: Replace fixture builders.**

For every test that writes a `_index.json` and a `_offsets.json` next to a `data.ndjson`, replace those `writeFileSync` calls with a single call to `buildIndexFromNDJson`:

```ts
import { buildIndexFromNDJson } from "./index-builder";

// In each test setup that writes data.ndjson + _index.json + _offsets.json:
await buildIndexFromNDJson(typeDir, (rec) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith("_") && k !== "_id") continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
});
```

For tests that exercise the legacy per-`{id}.json` path, leave them unchanged — that path still writes per-file `{id}.json` and no SQLite (Task 5 only backfills if `data.ndjson` exists).

- [ ] **Step 3: Run the snapshot-fs tests.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full data-layer test suite.**

Run: `cd aic-pipeline && npx vitest run src/lib/data`
Expected: PASS.

- [ ] **Step 5: Commit Tasks 5–9.**

```bash
git add aic-pipeline/src/lib/data/snapshot-fs.ts aic-pipeline/src/lib/data/snapshot-fs.test.ts
git commit -m "feat(data): SQLite-backed list/search/read; lazy backfill for legacy snapshots"
```

---

## Task 10: Lifecycle integration test

**Files:**
- Modify: `tests/api/data/lifecycle.test.ts`

The repo's existing lifecycle test asserts on a hardcoded list of files in the type directory at lines 95–97 — that list still names `_index.json` and `_offsets.json`. After Task 4 the directory contents will differ, so the assertion needs to be rewritten. This task also adds an explicit lazy-backfill test using the same scaffolding pattern.

- [ ] **Step 1: Update the existing post-pull file-list assertion.**

Open `tests/api/data/lifecycle.test.ts`. Find the assertion at lines 95–97:
```ts
    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "alpha_user");
    expect(fs.readdirSync(typeDir).sort()).toEqual([
      "_index.json", "_manifest.json", "_offsets.json", "_refs.json", "data.ndjson",
    ]);
```

Replace with:
```ts
    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "alpha_user");
    const entries = fs.readdirSync(typeDir).sort();
    // Filter SQLite WAL/SHM sidecars — present only if WAL hasn't checkpointed yet.
    const stable = entries.filter((e) => !e.endsWith("-wal") && !e.endsWith("-shm"));
    expect(stable).toEqual([
      "_manifest.json", "_refs.json", "data.ndjson", "index.sqlite",
    ]);
    expect(stable).not.toContain("_index.json");
    expect(stable).not.toContain("_offsets.json");
```

- [ ] **Step 2: Add a lazy-backfill test.**

Append this new `it()` block inside the `describe("data API lifecycle", ...)` block (after the last existing test in the suite):

```ts
  it("backfills index.sqlite for a pre-SQLite snapshot on first read", async () => {
    vi.resetModules();
    const recordsRoute = await import("@/app/api/data/records/[env]/[type]/route");

    // Simulate a pre-SQLite snapshot: data.ndjson + _manifest.json only.
    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "legacy_user");
    fs.mkdirSync(typeDir, { recursive: true });
    fs.writeFileSync(
      path.join(typeDir, "data.ndjson"),
      [
        JSON.stringify({ _id: "a", userName: "alice" }),
        JSON.stringify({ _id: "b", userName: "bob" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(typeDir, "_manifest.json"),
      JSON.stringify({ type: "legacy_user", pulledAt: Date.now(), count: 2, jobId: "seed" }),
    );

    const req = new NextRequest("http://localhost/api/data/records/test-env/legacy_user?q=&page=1&limit=10");
    const res = await recordsRoute.GET(
      req,
      { params: Promise.resolve({ env: "test-env", type: "legacy_user" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(2);
    expect(json.records.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
    expect(fs.existsSync(path.join(typeDir, "index.sqlite"))).toBe(true);
  });
```

- [ ] **Step 3: Run the lifecycle suite.**

Run: `cd aic-pipeline && npx vitest run tests/api/data/lifecycle.test.ts`
Expected: PASS — both the updated file-list assertion and the new backfill test green.

- [ ] **Step 4: Run the full test suite.**

Run: `cd aic-pipeline && npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add aic-pipeline/tests/api/data/lifecycle.test.ts
git commit -m "test(data): update lifecycle file-list assertion + add lazy backfill test"
```

---

## Task 11: Performance smoke test

**Files:**
- Create: `src/lib/data/index-builder.perf.test.ts` (gated by `RUN_PERF=1`)

- [ ] **Step 1: Add a perf-gated test.**

Create `src/lib/data/index-builder.perf.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { buildIndexFromNDJson } from "./index-builder";
import { openIndexDb } from "./index-db";
import { NDJSON_FILE } from "./ndjson-format";

const skip = process.env.RUN_PERF !== "1";

describe.skipIf(skip)("buildIndexFromNDJson — performance", () => {
  it("indexes 100k records in under 5 seconds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-"));
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      lines.push(JSON.stringify({ _id: `id-${i}`, userName: `user-${i}`, givenName: `given-${i}` }));
    }
    fs.writeFileSync(path.join(dir, NDJSON_FILE), lines.join("\n") + "\n");

    const t0 = Date.now();
    const n = await buildIndexFromNDJson(dir, (r) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("_") && k !== "_id") continue;
        if (typeof v === "string") out[k] = v;
      }
      return out;
    });
    const elapsed = Date.now() - t0;

    expect(n).toBe(100_000);
    expect(elapsed).toBeLessThan(5000);

    const db = openIndexDb(dir);
    const c = (db.prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c;
    db.close();
    expect(c).toBe(100_000);
  });
});
```

- [ ] **Step 2: Run with the gate.**

Run: `cd aic-pipeline && RUN_PERF=1 npx vitest run src/lib/data/index-builder.perf.test.ts`
Expected: PASS, builder finishes in ≤ 5s on a developer laptop.

- [ ] **Step 3: Run without the gate to confirm it's skipped by default.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/index-builder.perf.test.ts`
Expected: 1 skipped, 0 failures.

- [ ] **Step 4: Commit.**

```bash
git add aic-pipeline/src/lib/data/index-builder.perf.test.ts
git commit -m "test(data): add perf smoke test for index builder (gated by RUN_PERF)"
```

---

## Final verification

- [ ] **Step 1: Full typecheck + tests.**

```bash
cd aic-pipeline && npx tsc --noEmit && npm test
```
Expected: PASS.

- [ ] **Step 2: Manual exercise.**

```bash
cd aic-pipeline && npm run dev
```
- Trigger a pull on a small env in the UI.
- Verify `environments/<env>/managed-data/<type>/index.sqlite` exists and `_index.json` does not.
- Open `/data/browse`, select the type, search for a substring, page through results.
- Click a record and confirm the detail pane loads (exercises `readRecord`).

- [ ] **Step 3: One-line operator note.**

Add a paragraph to `aic-pipeline/CHANGELOG.md` (search for the format used by previous entries and match it):
```
- (data) Managed-data snapshots now use a per-type `index.sqlite` for browse/search.
  Old snapshots auto-upgrade on first read; `_index.json`/`_offsets.json` are no
  longer written. SQLite is embedded (`better-sqlite3`) — no new services.
```

- [ ] **Step 4: Commit.**

```bash
git add aic-pipeline/CHANGELOG.md
git commit -m "docs(changelog): note SQLite-backed managed-data index"
```

---

## Risks + rollback

- **Native-build failure:** if `better-sqlite3` lacks a prebuilt for an ops platform (rare; covers Mac/Linux x64+arm64 and Windows x64), `npm install` will compile from source. Verify in CI on each target before merging.
- **Schema migrations:** `SCHEMA_VERSION` exists for future use. v1 ships with no migration code; if v2 is ever needed, add an upgrade branch in `openIndexDb` keyed off the meta value.
- **Rollback:** revert the merge commit. Pulled snapshots retain their `data.ndjson` and `_manifest.json`; the post-revert reader will see no `_index.json` and follow the legacy NDJSON-streaming search path. Slower, but correct.
- **DB corruption:** `index.sqlite` is a derived index. Delete it and the next read rebuilds it from `data.ndjson` via the lazy-backfill path.
