# Local Log Archive — Design

**Date:** 2026-06-03
**Status:** Design approved in principle (pending spec write for Phase A1)
**Author:** brainstorming session

## Problem

The Journey execution history report (and any other log analysis) queries AIC's
`/monitoring/logs` endpoint live on every run. This has three problems:

1. **Truncation.** Busy prod journeys (e.g. `kyid_2B1_MasterLogin`) exceed the
   per-run event cap, so a whole day can't be analyzed in one pass.
2. **Slowness / repetition.** Every analysis re-pages the same data over the wire.
3. **Single-purpose.** Data is consumed by one report and thrown away; we can't
   run "all kinds of analysis" against it.

We want to **pull AIC logs down to local storage once** and run repeated, varied
analysis against the local copy, hitting AIC only to *extend* the archive.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Goal | **Both** a local archive (source of truth) **and** an in-app explore/query layer over it |
| Sources | **Everything** — AM (`am-authentication`, `am-access`, `am-core`) + IDM (`idm-access`, `idm-activity`, `idm-authentication`) |
| Accumulation | **Incremental** — later pulls extend coverage; overlapping entries de-duplicated |
| Scale target | **Weeks to months** (tens of millions of entries) |
| Query engine | **SQLite, partitioned** (reuse shipped `better-sqlite3` + `index-builder`); DuckDB deferred unless analytical queries get slow |
| Pull trigger | **Manual + "catch up to now"** (scheduled deferred) |
| Explore UX | **Structured filters + prebuilt reports** (no SQL console for now) |

## Architecture

A new **`log-archive`** subsystem parallel to the existing `managed-data`,
reusing its job framework, NDJSON+SQLite conventions, streaming-progress
protocol, and heap-safety. The on-disk partitioned NDJSON is the source of
truth; queries/reports read locally; AIC is hit only to extend the archive.

### Storage layout

```
ENVIRONMENTS_DIR/{env}/log-data/
├── .jobs/{jobId}.json              # job state (mirrors data-pull jobs)
├── manifest.json                   # covered time ranges + lastPulledTo, per source
└── {source}/                       # am-authentication, am-access, am-core, idm-*
    ├── 2026-06-01.ndjson           # append-only daily partition (one entry/line)
    ├── 2026-06-01.sqlite           # per-day index (flattened searchable columns)
    └── …
```

**Partition by source + UTC day.** Keeps every file/index bounded (critical at
tens of millions over months), makes time-range queries cheap (open only the
days in range), and makes incremental appends trivial.

### Incremental + dedup (key simplification)

Each AIC log entry carries a unique id at **`payload._id`** (measured — e.g.
`0d07e2b1-a9ab-4d37-802a-3c82e9664b00-524105`; note it is NOT a top-level field,
and timestamps are sub-millisecond-close so they are not a safe key).
The per-day SQLite uses `payload._id` as PRIMARY KEY with `INSERT OR IGNORE`; a
line is appended to the day's NDJSON **only when the insert was actually new**.
Consequences:

- Overlapping windows de-duplicate automatically.
- **Resume is trivial** — re-fetching a half-done page just re-inserts already-seen
  `_id`s (ignored). We can drop managed-data's byte-truncate-on-resume machinery;
  we only persist the page cookie.
- **Memory stays flat regardless of volume** — dedup lives in SQLite, not an
  in-memory set; each page streams straight to disk. This permanently removes the
  truncation problem.

`manifest.json` tracks merged `coveredRanges` + `lastPulledTo` per source,
powering "catch up to now" (pull `[lastPulledTo, now]`).

### Pull job

A `LogPullJob` mirroring `DataPullJob`, with per-**source** progress instead of
per-type. The pager:

- uses the corrected CREST response field `pagedResultsCookie` (no underscore;
  see the journey-history fix) and an explicit `_pageSize` (1000),
- pages each source to exhaustion (no artificial event cap),
- **is rate-limit aware (mandatory)** — AIC enforces ~**60 requests/window**
  (`x-ratelimit-limit: 60`, with `x-ratelimit-remaining`/`x-ratelimit-reset`
  headers) and returns **HTTP 429 + `Retry-After: 3`** when exceeded. The pager
  paces to stay under the limit using the remaining/reset headers and honors
  429/Retry-After with backoff. This is the throughput ceiling, not an edge case.
- streams the same NDJSON progress protocol used by the journey route,
- inherits heap-pressure auto-suspend.

Because AIC returns **no total count** (`totalPagedResults: -1`,
`totalPagedResultsPolicy: NONE`), progress is reported as entries-fetched +
elapsed + current cursor — never a percentage.

Lifecycle/state machine and `.jobs/` persistence reuse the job-registry pattern.

### Reports read local-first

`analyzeJourneyHistory` already takes `RawAuthEvent[]`, so it is untouched. The
journey route gains a **source toggle: Live (current) | Archive (read
`am-authentication` entries for the window from the local store, feed the
analyzer)**. Whole-day / multi-day journey reports become instant and never
truncate.

### Explore layer (B)

A new "Log archive" panel: env + sources + time range + filters (transactionId,
eventName, level, userId, realm, free-text), querying the partitioned SQLite
(UNION across days in range) with a paginated results table + drill-down — plus
prebuilt analyses (journey report, error rates, top failure nodes) reading the
same local store.

## Module breakdown (each independently testable)

- `lib/logs/log-archive-paths.ts` — path / day-partition helpers
- `lib/logs/manifest.ts` — covered-range merge logic
- `lib/logs/log-index.ts` — per-day SQLite open/insert/query (reuses
  `better-sqlite3` + `index-builder` helpers)
- `lib/logs/log-archive-store.ts` — partitioned NDJSON write/read + dedup
  orchestration
- `lib/logs/log-pull-runner.ts` — paginated fetch → store, resume, heap-suspend,
  **rate-limit pacing + 429/Retry-After backoff**
- `lib/logs/log-job-registry.ts` — job lifecycle / persistence
- API under `api/logs/archive/` (`pull` streaming, `jobs`,
  `jobs/[id]/suspend|resume`, `query`, `manifest`)
- UI: archive panel + journey-route source toggle

## Build order (each its own spec → plan → implementation cycle)

1. **A1 — storage core** (paths, manifest, index, store): pure libs, TDD. Foundation.
2. **A2 — pull runner + job registry + API + minimal pull UI**: logs on disk, resumable.
3. **A3 — journey report reads archive**: first visible payoff.
4. **B — explore UI**: filters, results, prebuilt analyses.

## Open questions / to verify during implementation

- Exact response field names per source (AM structured vs `am-core` plain-text).
- Whether the 60/window rate limit is per-API-key, per-tenant, or per-source
  (assume shared/per-tenant → pull sources sequentially; parallelism won't beat
  the ceiling).
- Disk budget for "weeks to months" — strongly consider gzipping NDJSON
  partitions (payloads are ~776 bytes of JSON text each; gzip ≈ 5–10×).

## Timing baseline (measured 2026-06-03, prod, `am-authentication`, 2026-06-02 full day)

Run against the live tenant with corrected pagination. Key results:

- **Pagination fix validated against live data** — paged cleanly via
  `pagedResultsCookie` (the old `_pagedResultsCookie` bug would have stopped at
  page 1).
- **Rate limit is the dominant cost.** AIC allows ~**60 requests/window**
  (`x-ratelimit-limit: 60`) and returns **429 + `Retry-After: 3s`** when
  exceeded. A naive pull (3s backoff, 250ms inter-page delay) spent **55% of
  wall-clock in backoff**.
- **No total count** returned (`totalPagedResults: -1`, policy `NONE`).
- **Volume (one source, one day): >317,000 entries and not finished** in a ~9-min
  capped run; ~**776 bytes/entry** → ~**246 MB** raw JSON and climbing.
- **Dedup key:** `payload._id` (unique per entry).
- **Throughput:** naive run ≈ 585 entries/s; the theoretical ceiling with perfect
  pacing is ~60 pages/min = ~**60,000 entries/min** (~1,000/s).

### Full-day / backfill estimate

| Scope | Entries (est.) | Time at optimal pacing | Raw disk |
|---|---|---|---|
| `am-authentication`, 1 day | ~0.4–0.6 M | **~7–10 min** | ~0.3–0.5 GB |
| All 6 sources, 1 day | ~1–2 M+ | **~20–40+ min** | ~0.8–1.5 GB |
| "Weeks to months" backfill | tens of millions | **many hours** (rate-limit bound) | tens to >100 GB |

**Implications (now baked into the design):** the pull must be a resumable
background job with rate-limit pacing; the initial backfill is a multi-hour,
multi-GB operation, after which incremental "catch up to now" keeps it cheap;
partitioned storage + gzip are warranted by the disk budget.
