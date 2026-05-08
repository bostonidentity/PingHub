# Managed Object "Find Usage" — Design

**Date:** 2026-05-08
**Status:** Approved (design); implementation plan to follow.

## 1. Goal

Add a "Find Usage" capability to the Managed Object detail view in the browse tab, analogous to the existing scripts find-usage feature. Given a managed object *type* (e.g., `alpha_user`), surface every place in the locally-cached environment config where that type is referenced — across journeys, the script library, custom-endpoint scripts, IGA workflows, sync mappings, managed-object hooks, schedulers, and other config artifacts.

Find-usage operates on the **type/schema**, not on individual record instances. Record-level usage (where a specific user/role is referenced) is explicitly out of scope for v1.

## 2. Non-goals (v1)

- Cross-environment search. One env per request.
- Detecting dynamically-constructed paths such as `"managed/" + MOName`. Known limitation, called out in UI copy if it surfaces as a real problem.
- Suppressing matches inside JS/JSON comments. False-positive rate from comments is expected to be very low.
- Searching/filtering inside the result panel.
- Persisted or cached results. Every click recomputes.
- Editor-grade deep-linking beyond whatever file viewer is already wired into the app.
- Record-instance find-usage.

## 3. Architecture

```
[Browse tab — Managed Object detail header]
        │  click "Find Usage"
        ▼
[GET /api/analyze/managed-object-usage?env=<env>&type=<type>]
        │  walks env config dir, regex-matches .json + .js,
        │  categorizes by file-path prefix, captures nearest JSON
        │  field name when applicable
        ▼
[JSON: { hits: Hit[], counts: { byCategory: {...} } }]
        ▼
[Results panel — grouped by category, click-through to file]
```

Structurally this mirrors `aic-pipeline/src/app/api/analyze/script-usage/route.ts` and `aic-pipeline/src/app/api/analyze/esv-usages/route.ts`: a single GET, no DB, streaming directory walk, JSON response.

## 4. API route

**Path:** `aic-pipeline/src/app/api/analyze/managed-object-usage/route.ts`
**Method:** `GET`

**Query params:**
- `env` (required) — environment key, validated against the existing env list.
- `type` (required) — managed object type, exact, e.g. `alpha_user`. Must match `^[A-Za-z0-9_-]+$`.

**Search query:** the literal string `managed/<type>`, never widened. No realm-prefix expansion: `alpha_user` does not match `user`.

**Response shape:**

```ts
type Category =
  | "journey"
  | "script-library"
  | "script-library-config"
  | "custom-endpoint"
  | "workflow"
  | "iga-assignment"
  | "iga-form"
  | "managed-object-config"
  | "sync-mapping"
  | "scheduler"
  | "internal-role"
  | "access-config"
  | "connector-agent"
  | "other";

type Hit = {
  category: Category;
  filePath: string;          // relative to env config root, forward-slash
  line: number;              // 1-based
  column: number;            // 1-based, start of match
  snippet: string;           // matched line, trimmed to ~200 chars
  fieldName: string | null;  // nearest enclosing JSON key (null for .js or unknown)
  realmRoot: string | null;  // e.g. "alpha", null for global config
  isSelfReference: boolean;  // true if file is under managed-objects/<type>/...
};

type Response = {
  env: string;
  type: string;
  query: string;             // "managed/<type>"
  scanned: {
    files: number;
    bytes: number;
    ms: number;
    skipped: number;         // files skipped due to size cap
    errors: number;          // per-file read errors
  };
  truncated: boolean;
  hits: Hit[];
  counts: { byCategory: Record<Category, number> };
};
```

### 4.1 Search algorithm

1. Resolve env config root via the existing `getConfigDir(env)` helper. 404 if missing.
2. Walk the tree filtering to `.json` and `.js`. Skip `node_modules`, `.git`, hidden dirs. Only descend into roots returned by `getConfigDir()` / `getRealmRoots()`.
3. For each file, read line-by-line (`fs.createReadStream` + line splitter) and apply a single precompiled regex per request:
   `\bmanaged/<escaped-type>(?=[/"'\s,)\]}]|$)`
   The right-hand lookahead anchors the match so `alpha_user_extra` does not match `alpha_user`.
4. For `.json` hits, scan backward in the same file from the match offset to find the nearest unmatched `"<key>":` token; that's `fieldName`. Cap lookback at 4 KB. If not found, leave `null`.
5. Categorize the hit by file-path prefix using the table in §5. First match wins.
6. Mark `isSelfReference: true` when the hit's file is under `*/managed-objects/<type>/...`.
7. Stop when total hits ≥ the hit cap; set `truncated: true`.

### 4.2 Limits and timeouts

Defaults; configurable via env vars at plan time:

- Max files scanned: **20,000**
- Max bytes per file: **5 MB** (oversize files counted in `scanned.skipped`)
- Max total hits: **2,000**
- Per-request timeout: **30 s** (return what we have with `truncated: true`)

Sequential walk is sufficient for v1; existing analyze routes follow the same pattern over comparable trees.

### 4.3 Error handling

- 400 — missing/invalid `env` or `type` (regex check fails).
- 404 — env config dir does not exist.
- 500 — unexpected error during walk, body `{ error: string }`.
- Per-file read errors are logged and counted in `scanned.errors` but do not fail the request.
- No partial-success swallowing: a top-level walk failure returns 500.

### 4.4 Security

- `type` is regex-escaped before interpolation.
- `env` is validated against the existing env allow-list; never concatenated into paths beyond what `getConfigDir()` returns.

### 4.5 Logging

One server log line per request: `{ env, type, files, hits, ms, truncated }`. Never log file contents or script bodies.

## 5. Path-prefix → Category map

Paths are matched against the file path *relative to the env config root*, forward-slash normalized. Order matters: first match wins. The leading `*/` accommodates realm-rooted paths like `alpha/journeys/...`.

| # | Prefix pattern | Category |
|---|---|---|
| 1 | `*/journeys/**/*.json` | `journey` |
| 2 | `*/scripts/scripts-content/**/*.js` | `script-library` |
| 3 | `*/scripts/scripts-config/**/*.json` | `script-library-config` |
| 4 | `endpoints/**/*.{json,js}` | `custom-endpoint` |
| 5 | `iga/workflows/**/*.json` | `workflow` |
| 6 | `iga/assignments/**/*.json` | `iga-assignment` |
| 7 | `iga/forms/**/*.json` | `iga-form` |
| 8 | `*/managed-objects/**/*.{json,js}` | `managed-object-config` |
| 9 | `sync/mappings/**/*.json` | `sync-mapping` |
| 10 | `schedules/**/*.json` | `scheduler` |
| 11 | `internal-roles/**/*.json` | `internal-role` |
| 12 | `access-config/**` | `access-config` |
| 13 | `agents/**` | `connector-agent` |
| 14 | *(anything else)* | `other` |

The map lives as a single const in the route file. Adding new artifact dirs = one new row.

## 6. Client UI

### 6.1 Entry point

A `Find Usage` button in the Managed Object detail header in the browse tab. Disabled with tooltip "No type selected" when nothing is loaded. Spinner while a request is in flight. Placement and styling follow whatever the existing scripts "Find Usage" button does in `aic-pipeline/src/app/compare/DiffReport.tsx`, so the experiences feel consistent. Exact pixel-level placement decided at plan/implementation time.

### 6.2 Results panel

A new component, e.g. `aic-pipeline/src/app/data/browse/ManagedObjectUsagePanel.tsx`, mounted as an expandable section under the detail header (or side drawer — confirmed at plan time to match the scripts pattern).

Layout sketch:

```
┌ Find usage of "alpha_user"  ⟲  ✕ ┐
│  Scanned 1,284 files · 73 hits   │
├──────────────────────────────────┤
│ ▾ Journey (24)                   │
│   kyid_loginMain.json            │
│   line 4 · field: identityResource│
│   "managed/alpha_user",          │
│   ──                             │
│   ...                            │
│ ▾ Script library (31)            │
│ ▾ Custom endpoint (8)            │
│ ▾ Workflow (3)                   │
│ ▾ Sync mapping (4)               │
│ ▸ Other (3)                      │
└──────────────────────────────────┘
```

Group order matches the table in §5 (most-likely-relevant first); `other` is collapsed by default. Per row: relative file path, `line · field: <fieldName>` (omit field segment if `null`), one-line snippet, click → opens the file in the existing file viewer (fall back to copy-path if no viewer is wired). Hits with `isSelfReference: true` (file lives under the type's own `managed-objects/<type>/...` directory) get a small "self / hooks" tag on the row so the user can distinguish "the type's own onCreate/onUpdate hook references itself" from "another artifact references the type".

### 6.3 State

Local component state only — request, results, loading, error. No global store. Last query persists until panel close. No persisted cache.

### 6.4 Empty / partial states

- 0 hits → "No usages found in this environment."
- `truncated: true` → banner: "Showing first 2,000 hits — additional results were not loaded." Sets expectations; v1 has no in-panel refinement.
- API error → inline error with retry.

## 7. Testing

- Unit tests for the path-prefix → category mapper. Table-driven, one case per category, plus `other` fallbacks, plus realm-prefix `*/...` cases.
- Unit tests for the JSON nearest-field-name lookback. Cases: simple `"identityResource": "managed/alpha_user"`, nested objects, arrays, no preceding key (`null`), key beyond the 4 KB lookback cap (`null`).
- Integration test for the route against a small fixture env tree at `aic-pipeline/test-fixtures/managed-object-usage/`. One file per category with a known reference, plus a decoy (`alpha_user_extra` must not match `alpha_user`) to verify the word-boundary lookahead.
- Truncation test: fixture exceeding the hit cap; assert `truncated: true` and that scanning stops cleanly.

## 8. Telemetry

- One server log line per request (fields listed in §4.5).
- No new client analytics events in v1 — match the scripts find-usage baseline.

## 9. Open items (resolved at plan/implementation time)

- Exact button placement in the Managed Object detail header (mirror scripts find-usage).
- Exact file-viewer integration on row click (reuse the viewer scripts find-usage uses).

These do not block the design.
