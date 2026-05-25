# Large Managed-Data Pulls: NDJSON Storage + Resumable Jobs

**Status:** Design — pending implementation plan
**Date:** 2026-04-28

## Problem

Pulling large managed-object types (>200k records) from an AIC tenant is slow and fragile in two ways:

1. **Per-record file I/O.** `pull-runner.ts` writes one `{id}.json` file per record (`pull-runner.ts:235`). For 200k records that's 200k synchronous `fs.writeFileSync` calls plus 200k inodes plus a directory rename of all of them at the end. Filesystem operations dominate wall-clock time.
2. **No resumability.** If the Next.js process restarts mid-pull (HMR, deploy, crash), `job-registry.ts` marks the job `failed` on boot and the user starts over from page 1. There's no persisted cookie or partial-state recovery.

A concrete trigger case: in the UAT tenant, `alpha_tenant_access` has more than 200,000 records and the tenant rejects `_countPolicy` with HTTP 400 ("Unrecognized request parameter"). The count probe gives up at the 200,000 pagination cap and the UI shows "unknown." The pull itself isn't capped, but the pull has the same fragility issues plus no progress denominator.

## Goal

Pull arbitrarily large managed types reliably and reasonably fast, without breaking existing pulled snapshots on disk.

## Non-goals

- Parallel pulling across types.
- Parallel slicing within a single type via `_queryFilter` ID ranges.
- Background-worker / out-of-process execution (pull stays in the Next.js process).
- Fixing the UAT tenant's `_countPolicy` rejection — tenant-side issue. Pulls run with `total: null` and the UI renders `fetched / —`.
- Migrating existing legacy snapshots automatically (natural replacement on next pull only).

## Approach

Three changes bundled into one feature, all gated by an on-disk format-detection rule so legacy snapshots keep working:

1. **NDJSON storage format** for newly pulled types.
2. **Configurable page size**, defaulting to 5000, overridable per-env.
3. **Resumable jobs** with a new `interrupted` status and per-page cookie persistence.

## On-disk format

Each `environments/{env}/managed-data/{type}/` directory pulled with the new format contains:

```
data.ndjson        # one JSON record per line, no pretty-print, append-only during pull
_offsets.json      # { "<id>": <byteOffset>, ... } for O(1) random access
_index.json        # unchanged: [{ id, f: {short fields} }, ...]
_refs.json         # unchanged: { "<id>": ["managed/type/id", ...] }
_manifest.json     # unchanged: { type, pulledAt, count, jobId }
```

**Format-detection rule** used by every reader: `fs.existsSync(path.join(typeDir, "data.ndjson"))`. True → new path. False → legacy `{id}.json` path.

**Why retain `_index.json` and `_refs.json` as JSON** rather than NDJSON: they're already built and consumed in memory; for 200k–1M records they're 40–100MB and fit comfortably; converting them would force changes in additional reader spots for marginal gain. Revisit if/when truly enormous types appear.

**Why a JSON object for offsets, not NDJSON:** offsets need random lookup by id; loading the whole map once is simpler than seeking through an offsets file. If memory becomes an issue we switch to a sorted offsets file + binary search later.

**Atomic-swap behavior** is unchanged: pull writes into `.pulling-{jobId}/{type}/`, then renames into place. With one big NDJSON file instead of 200k small ones, the rename is now genuinely fast (and the existing `renameWithRetry` Windows-locks helper has far less to retry against).

## Pull-runner changes (`src/lib/data/pull-runner.ts`)

**Per-type write loop** (replaces per-record `fs.writeFileSync` at line 235):

- Open `data.ndjson` with `fs.createWriteStream(..., { flags: "a" })` for the type's `.pulling-` staging dir.
- For each record on a page: capture the byte offset *before* the write into an in-memory `offsets: Record<string, number>` map; serialize the record as one line (no pretty-print); write it. Append to in-memory `indexEntries` and `refsIndex` exactly as today.
- After all records on a page are written: drain the stream and capture `byteLength = stream.bytesWritten`.
- Persist `{ cookie, fetched, byteLength }` for this type via a new `registry.updateProgress(jobId, type, { cookie, byteLength })` call.
- If `cookie === null` → last page, fall through to atomic swap.

**Atomic swap** (end of type): write `_offsets.json`, `_index.json`, `_refs.json`, `_manifest.json`, then `renameWithRetry` the staging dir into place.

**Page size:** read once at top of `runPull`. Order of precedence:

1. `Environment.pageSize` from `environments.json` (per-env)
2. `process.env.DATA_PULL_PAGE_SIZE` (global override)
3. `5000` (default)

The constant `PAGE_SIZE = 1000` at line 8 is removed.

**Preflight count** (lines 116–149) is unchanged — already returns `null` when the tenant rejects `_countPolicy`. Pull will render `fetched / —` in such envs.

**Resume entry point.** When `runPull` is invoked for a job whose status is `interrupted`:

- For each type with `status: "running"` and persisted `cookie`:
  - Open `data.ndjson` for **append**, then `fs.truncateSync(path, byteLength)` to drop any half-written final line from the crash.
  - Stream-read the truncated NDJSON to rebuild in-memory `offsets`, `indexEntries`, `refsIndex`.
  - Resume pagination from the persisted `cookie`.
- For types with `status: "done"` or `status: "failed"`: skip — already finalized.
- For types with `status: "pending"`: start from page 1 as today.

**Retry budget:** bump `MAX_RETRIES` from 2 to 5 for page fetches. With resume in place, the cost of giving up on a page is "user clicks Resume," so we should be patient on transient blips during a long pull. The 429-backoff schedule extends to `[5s, 10s, 20s, 40s, 60s]`.

**Crash safety guarantees:**

- After page N completes and registry persists, `data.ndjson` contains exactly the first N pages, no half-lines.
- If the process dies *during* a page write, the truncate-on-resume drops the partial tail before continuing from the previous cookie.
- Records may be written but the registry update may not have flushed yet (narrow window): on resume, the next page's records may include duplicates of the last persisted page. The runner skips a record if its `_id` already appears in the rebuilt `offsets` map.

**Cookie expiry on resume.** AIC's `_pagedResultsCookie` is opaque and not documented as durable across long gaps. If a resumed page fetch returns an HTTP error indicating the cookie is no longer valid, mark the type `failed` with a clear error message ("paged results cookie expired — please start a fresh pull"). User can then start a new job to redo from scratch.

## Job-registry & API changes

**New job status:** `"interrupted"` joins `queued`, `running`, `completed`, `failed`, `aborted`.

**Per-type progress shape** (`DataPullJob.types[].progress`) gains:

```ts
cookie?: string | null;   // last persisted _pagedResultsCookie (null = last page reached)
byteLength?: number;      // bytes written to data.ndjson when cookie was persisted
```

**Server-boot recovery** (currently at `job-registry.ts:53`, marks running jobs `failed`):

- Jobs in `running` status at boot become `interrupted` instead, preserving cookie + byteLength + per-type status.
- Per-type status untouched: running types stay `running` (resume picks up from there); completed types stay `done`; pending types stay `pending`.
- Jobs already in `aborted` / `failed` / `completed` / `interrupted` are untouched.

**New endpoint:** `POST /api/data/pull/jobs/[jobId]/resume`

- Loads the job. If status is not `interrupted`, returns 409.
- Mints a fresh token, spawns `runPull` with a new `AbortController`. The runner sees the per-type `cookie`/`byteLength` and uses the resume entry point.
- Returns `202 Accepted` with the same job id.
- Subject to the same env-level concurrency rule as `POST /api/data/pull` — 409 if another job is active for this env.

**Existing endpoints** (`POST /api/data/pull`, `POST /api/data/pull/jobs/[jobId]/abort`) are unchanged.

**No "restart from scratch" endpoint.** Users who want that on an interrupted job re-select the types and click Start; the new pull writes to a new staging dir and atomic-swaps over. The interrupted job stays in the registry as a historical record.

## Reader shim

A small helper `isNDJsonFormat(typeDir)` checks `fs.existsSync(path.join(typeDir, "data.ndjson"))`. Each reader call site branches on it once.

**`src/lib/data/snapshot-fs.ts`:**

- `loadCache()` (lines 46–92): when NDJSON, read `_offsets.json` for record count + ids; sample first 20 records by reading the first ~20 lines of `data.ndjson` to derive fields. `_index.json` consumption (lines 62–67) is unchanged.
- `readRecord()` (lines 116–125): when NDJSON, look up byte offset in `_offsets.json`, `fs.openSync` + `fs.read` from offset until newline.
- `listRecords()` (lines 149–234): fast-path via `_index.json` (lines 168–214) is unchanged. Only the fallback raw-text-search branch (lines 216–232) needs a new path that streams `data.ndjson` line by line.
- `listSnapshotTypes()` (lines 94–114): unchanged — reads `_manifest.json` only.

**`/api/data/records/[env]/[type]/[id]/route.ts`** — calls `readRecord()`. No change here; the shim lives in `readRecord`.

**`/api/data/refs/[env]/[type]/[id]/route.ts`** — reads `_refs.json`. No change.

**`/api/data/search/[env]/route.ts`** (lines 76–94) — currently iterates types then `readdirSync` on each type dir, reading every `{id}.json`. New path: when NDJSON, stream `data.ndjson` line by line, parse, text-match. Both branches share the same matcher.

**`/api/data/export/[env]/[type]/route.ts`** (lines 33–52) — currently lists files and reads each. New path: when NDJSON, stream `data.ndjson` line by line into the export pipeline.

## UI changes

**`JobCard.tsx`:**

- New status pill color for `interrupted` — distinct from `failed` (red) and `completed` (green); amber/yellow with an icon.
- New **Resume** button visible when `job.status === "interrupted"`. Calls `POST /api/data/pull/jobs/{id}/resume`. Disabled if any other job for the same env is currently active.
- Existing **Abort** button stays available on `interrupted` jobs.
- Per-type rows already render correctly for interrupted jobs.

**`PullPanel.tsx`** — no change to start-pull flow. The "unknown" count handling at line 363 stays as-is.

**`EnvEditor.tsx`** — new "Pull page size" numeric input in the metadata row, placeholder "5000". Stored as `Environment.pageSize` in `environments.json`.

**`EnvironmentsManager.tsx`** add-wizard — same field, optional, on Step 1 (meta).

**`useDataPullJobs.ts`** — no behavioral change; the polling hook's TypeScript types pick up the new status and progress fields.

**Type changes:**

- `JobStatus` (`src/lib/data/types.ts`): add `"interrupted"`.
- `TypeProgress`: add optional `cookie?: string | null`, `byteLength?: number`.
- `Environment` (`src/lib/fr-config-types.ts`): add optional `pageSize?: number`.

## Testing strategy

**New unit tests in `pull-runner.test.ts`:**

1. **NDJSON happy path** — pull a small type, assert staging dir contains `data.ndjson` (one parseable line per record), `_offsets.json` (correct byte offset for each id, verifiable by seeking), `_index.json`, `_refs.json`, `_manifest.json`. No `{id}.json` files.
2. **Page size from env config** — assert request URL contains `_pageSize=N` where N comes from `Environment.pageSize`, falls back to `DATA_PULL_PAGE_SIZE`, then `5000`.
3. **Cookie persistence** — mock fetch to return 3 pages; after each page, assert `registry.updateProgress` was called with `cookie` + `byteLength`.
4. **Resume after crash** — pre-state has `data.ndjson` with first 2 pages plus a half-written third record; registry has `cookie="page3", byteLength=<end of page 2>`. Invoke `runPull`. Assert: file truncated to `byteLength`, in-memory state rebuilt by streaming, pagination resumes from `cookie="page3"`, final snapshot identical to a clean run.
5. **Resume dedupe** — registry crashed *before* persisting after page 2; on resume, page 2 is fetched again. Assert no duplicate lines in `data.ndjson` (dedupe via rebuilt offsets map).
6. **Retry budget** — fail a page transiently 4 times then succeed; assert pull continues (new MAX_RETRIES=5 absorbs it).
7. **Cookie expiry** — resume returns an error indicating cookie invalid; assert type marked `failed` with clear message; other types unaffected.

**New scenario in `lifecycle.test.ts`:** start a pull, abort the runner mid-page (simulating crash), invoke the resume API, assert the final snapshot matches a clean run.

**Reader-shim tests in `snapshot-fs.test.ts`:** parameterize existing tests to run against both legacy `{id}.json` fixtures and new NDJSON fixtures. Add explicit tests for `readRecord` byte-offset seeking and for the search-fallback streaming path.

## Manual smoke before merge

- Pull a small type in a sandbox env → confirm new files on disk; browse + detail + refs all work.
- Pull a previously-pulled type in another env → confirm legacy files still readable until repulled.
- Kill `next dev` mid-pull on a 50k-row type → UI shows `interrupted`, click Resume → snapshot completes and matches a clean reference pull.

## Acceptance / validation

After implementation lands, run a real pull in UAT for **all managed-object types whose name starts with `alpha_tenant`**. The original symptom that motivated this work was `alpha_tenant_access` showing "unknown" and being un-pullable in any practical sense. Acceptance is:

- Every `alpha_tenant*` type in UAT pulls to completion.
- The on-disk format for each is the new NDJSON layout (`data.ndjson` + `_offsets.json` + index/refs/manifest).
- The Data tab browses, searches, and exports each pulled type without errors.
- Record counts are reported correctly (or as `fetched / —` when the tenant rejects `_countPolicy`).
- Killing and resuming the dev server mid-pull at least once during this validation produces a complete snapshot indistinguishable from a clean run.

## Risks

- **`_offsets.json` size.** For 1M+ records this is 50–100MB JSON loaded into memory on first cache miss per type. Acceptable for now; revisit with a sorted-offsets file + binary search if memory pressure shows up.
- **Cookie durability.** AIC's `_pagedResultsCookie` is opaque and not documented as durable across long gaps. The cookie-expiry handling in the runner is the safety net; a long-resumed pull may need to be restarted from scratch.
- **Reader shim lifetime.** The format-detection branch will live in 4 reader spots until all envs have been repulled. Removing the shim is a clean follow-up once telemetry/`ls` confirms nothing remains in legacy format.

## Out of scope (for this spec)

- Parallel-type pulling.
- Parallel `_queryFilter` slicing within a type.
- Background-worker / out-of-process execution.
- A migration tool to convert legacy snapshots without re-fetching from the tenant.
- UI changes to surface pull throughput, ETA improvements, or per-page progress beyond what `JobCard.tsx` already shows.
