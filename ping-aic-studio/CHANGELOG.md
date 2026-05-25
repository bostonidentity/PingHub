# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-24

### Added

- **`./start`, `./stop`, `./status` scripts at the monorepo root** (Windows: `start.cmd` / `stop.cmd` / `status.cmd`) for end-user launch. After `git clone https://github.com/bostonidentity/PingHub`:
  - `./start` detects OS, ensures Node 20+ (system Node if ≥ 20, else auto-downloads pinned 20.18.0 into `./ping-aic-studio/.pinghub-node/`), `npm install` / `npm run build` if needed, checks for upstream updates, then launches the server **in the background**. Browser auto-opens.
  - `./stop` reads the PID file, sends SIGTERM, escalates to SIGKILL after 3s, cleans up.
  - `./status` reports running/not-running with PID, URL, start time, log path.
- `launcher/launcher.mjs` — cross-platform Node launcher: port selection, server spawn, browser auto-open, clean SIGTERM shutdown.
- Server logs to `ping-aic-studio/.pinghub-logs/pinghub.log` with timestamped session headers; PID at `ping-aic-studio/.pinghub-logs/pinghub.pid`.
- Bootstrap flags: `--reinstall`, `--bundled-node`, `--skip-update`. Launcher flags: `--port`, `--no-open`, `--data-dir`, `-h`/`--help` on all three scripts.
- `postbuild` npm hook copies `.next/static` + `public` into the standalone tree so CSS/JS chunks serve correctly in production.

### Changed

- **Rebranding:** display name "AIC Pipeline" → "Ping AIC Studio" (page title, nav header, footer, READMEs, console output prefix `[Ping AIC Studio]`). NPM package name `pinghub` unchanged.
- **Folder renamed:** `aic-pipeline/` → `ping-aic-studio/` (file history preserved via `git mv`).
- Default port: 3000 (auto-falls-back to a free port if 3000 is occupied).
- `./start`'s data-dir resolution now matches `npm run dev` — reads `git-settings.json`'s `targetDir` (default `../environments`) and resolves to an absolute path before spawn, immune to the standalone server's `process.chdir(__dirname)` quirk.
- `./start` refuses to run a second instance when one is already alive (prints PID, URL, start time, log path).

### Removed

- Dead promote subcommand system (`/api/promote/route.ts`, `PromoteSubcommand` type, `PROMOTE_SUBCOMMANDS` array) — was unreachable since the active promote flow uses `/api/promote-items`.

### Fixed

- macOS bash 3.2 unbound-variable error when `./start` was invoked with no flags.
- Static asset 404s (Tailwind CSS not loading) when running the standalone production build — fixed by the new `postbuild` asset-sync step.

## [0.2.7.3] - 2026-05-22

### Added

- **Data > Pull: pagination for the activity list.** The "Active & recent jobs" list now paginates 10 at a time with Newer/Older buttons, a "Page X of Y" indicator, and a range counter in the header. Page resets when the environment changes and clamps if the job count shrinks.

### Fixed

- **Browse: attribute search now reaches nested, array, and relationship values.** The per-type SQLite index used to project only top-level scalars into `fields_json`, so picking an attribute like `profile.givenName`, `mail` (array), or `manager._ref` from the dropdown returned zero matches even though Global search (which streams `data.ndjson`) found them. Replaced `pickIndexFields` with a shared `flattenForIndex` helper that recursively walks the record producing dotted paths (`profile.givenName`, `profile.address.city`, `mail.0`, `manager._ref`) and keeps all `_*` keys at every depth. The attribute filter in `listRecords` now matches against every flat path with three rules (exact path, `attr.` prefix, or last-segment leaf) — and against each path's array-index-collapsed form too, so a dropdown pick like `content.myAppsDescription.en` matches the stored path `content.0.myAppsDescription.en`. The fields dropdown collapses array indices (`mail.0`, `mail.1` -> `mail`) so the list stays readable.
- **Browse: long descriptions are now searchable.** The per-leaf index cap was raised from 200 to 10 000 characters. Realistic content like dashboard widget descriptions, translated UI copy, and instructions was silently dropped from `fields_json` and therefore invisible to the attribute filter (e.g. searching `government` on `alpha_tenant_dashboardapplicationwidget.content.myAppsDescription.en` returned nothing despite a clear match in `data.ndjson`).
- **Browse: SQLite index auto-rebuilds on schema upgrade.** Bumped `SCHEMA_VERSION` to 4 and added a `meta` table; `openIndexDb` drops the stale `records` table on version mismatch *and* when it detects a v1 layout (records table present but no `meta.schemaVersion` row — the case that initially shipped silently stamped as v2 instead of being rebuilt). `loadCache` lazily rebuilds the index from the existing `data.ndjson` on first access — no re-pull required.

## [0.2.7.2] - 2026-05-22

### Added

- **Browse: per-type attribute + operator filter.** New attribute dropdown (sourced from the type's sampled fields), operator dropdown (includes, equals, starts with, ends with, regex), and a case-sensitive toggle next to the per-type record search input. Leaving the attribute blank preserves the existing whole-record substring behavior. `attr` / `op` / `caseSensitive` are threaded through `useSnapshotRecords` and the `/api/data/records/[env]/[type]` route; `listRecords` does a per-row scan against just the named field (case-insensitive key match) when `attr` is set, falling back to the original SQLite LIKE search otherwise.

### Fixed

- **Pull: release snapshot-fs SQLite handle before rename swap.** On Windows, the Browse panel's cached better-sqlite3 connection on a type's `index.sqlite` kept the directory locked, causing `EPERM: operation not permitted, rename` when the next pull tried to swap `currentDir` -> `.prev-<job>-<type>`. Calling `evictCache(currentDir)` right before `renameWithRetry` releases that handle so the atomic swap succeeds.
- **Logs Table view: selection vs match precedence and viewport stability.** `EntryRow` now splits `highlighted` into separate `selected` (sky) and `activeMatch` (amber) props so the user's clicked row stays visually distinct from the keyword-match cursor, with selection winning. Keyword matches in the active-match row render with `bg-amber-400` to match the terminal/JSON viewers; non-active rows stay `bg-yellow-200`. Dropped `selectedEntryIdx` from the scroll-to-selection effect deps so expanding/collapsing a row no longer re-centers the viewport (the effect now fires only on view-mode switch, as intended).
- **Logs Terminal view: prefer selection over match cursor on view switch.** When `selectedEntryIdx` and `matchScrollRequest` differ, the terminal view now reveals the user's selection instead of the keyword cursor.

## [0.2.7.1] - 2026-05-18

### Fixed

- **Logs Table view: pagination buttons work after clicking a row.** The center-selected-row effect had `page` in its dependency list, so any Older/Newer/Oldest click after a row had been clicked or highlighted immediately re-fired the effect and snapped `page` back to the page containing the selected entry. Removed `page` from the deps — the effect still recenters on view-mode switches and row selection but no longer fights manual pagination.
- **Logs Table view: tail no longer hides expanded rows.** Added a `tableManualPagingRef` flag that's set whenever the user manually paginates (Oldest / ← Older / Newer →) or expands any row, and cleared on Latest / Jump-to-bottom / page-size or filter changes. While set, the auto-tail effect no longer snaps `page` to the latest, so expanded entries stay visible as new entries stream in.

## [0.2.7.0] - 2026-05-15

### Added

- **Journey graph: hide unreachable nodes** toolbar toggle (default ON). Drops every node the journey can never reach from `startNode` plus their dangling edges, catching orphan sub-graphs in addition to single-node orphans.
- **Journey graph: ELK / Dagre layout selector**. Choice persists per-browser via `localStorage` key `journey-graph-layout-prefs`, restored synchronously via a lazy `useState` initializer so the saved engine is honored on first paint (no race with the persist effect).
- **Journey graph: left-drag pans, Shift+drag marquee selects.**
- **Journey graph: trace mode defaults to `neighbors`** instead of full graph for faster orientation.
- **Logs Expand-all / Collapse-all** toolbar buttons now work in **Table view** as well as Terminal-wrap view.
- **Tail terminal debug logger** gated by `localStorage.setItem('debug-tail','1')`. Instruments auto-scroll, anchor-on-growth, `handleScroll`, Jump-to-bottom, and scroll-to-match.

### Fixed

- **Tail terminal auto-scroll is now demote-only.** Any user interaction (manual scroll away, row click, scroll-to-match) pauses tailing; the only way to resume is the **Jump to bottom** button. Previously, scrolling back near the bottom would silently re-engage auto-scroll and yank the viewport.
- **Tail terminal blank-flash during tailing** when the user had scrolled up. Caused by the nowrap `scrollHeight` cap rescaling the same `scrollTop` to a different virtual position whenever `entries.length` grew — the rendered slice and the imperative transform briefly desynced and the row group translated above the viewport. Fixed with a layout effect that snapshots the pre-growth virtual position and adjusts `scrollTop` so the same virtual content stays under the same pixel.
- **Tail terminal blank-flash during auto-tail at bottom** (round-2 fix retained): `effectiveStartIdx` derived during render keeps the rendered slice and transform coherent in every commit, even across `startTransition` boundaries.

## [0.2.6.9] - 2026-05-15

### Fixed

- **Logs JSON view scroll-to-selected** now works reliably across view-switches, scroll-to-selected button clicks, and during/after tail. Root cause was that `@tanstack/react-virtual`'s `scrollToIndex` cannot be used with our custom `observeElementOffset` / `scrollToFn` configuration: it consistently called `scrollToFn(0)` regardless of the requested index because react-virtual's `measurementsCache` is only populated for currently-mounted rows. Replaced all four call sites (auto-tail, active-match, PIN, failsafe) with direct `applyVirtualOffset` math: cumulative-sum estimates for unrendered targets and `getBoundingClientRect`-based delta correction for rendered ones. The view now lands on the selected entry on the very first JSON-view mount, even when no row near the target was ever rendered before.
- **JSON view auto-tail** correctly jumps to the end of the buffer on mount instead of staying at offset 0 (which previously demoted `atBottomRef` and broke subsequent tail batches).
- **JSON view height cache** is preserved across Scroll-to-selected so per-row measurements survive view switches and don't reset to the 240px estimate.
- **Selection PIN** uses two-phase reveal — cumulative-sum estimate for the first frame, then a single DOM-rect delta correction once the row mounts — eliminating the multi-frame convergence loop that used to drift as adjacent rows were measured.

## [0.2.6.8] - 2026-05-14

### Added

- **Tenant health probe** drives the environment status pill on both the Dashboard and Environments tabs. A new background probe hits each tenant's `/monitoring/health` endpoint (no auth required, ~150ms), caches the result at `environments/<env>/health.json`, and surfaces it as a `healthy` / `checking…` / `unhealthy` pill with hover tooltip showing latency, last-checked time, and failure reason. The pill is now backed by a real reachability check instead of being derived from the last sync-pull status, so a clean tenant with a failed pull is reported as healthy-with-pull-warning rather than unhealthy.
- **Configurable probe interval per environment** via a new **Health probe (min)** field in the Env editor (1–1440 minutes, default 15). Persisted to `environments.json` as `healthIntervalMinutes` and enforced server-side.
- **Last-check timestamp** rendered under the health pill on every env tile (Dashboard + Environments tab), so freshness is visible at a glance without hovering.
- New shared `HealthBadge` component (`src/components/ui/HealthBadge.tsx`) used by both views; new `StatusPill` `title` prop for tooltip support.
- New API: `GET /api/health` returns the cache and kicks a background refresh for any env older than its interval; `POST /api/health/refresh` force-probes one env.
- New unit tests for `probeHealth`, `isStale`, and `clampInterval` (9 tests).

### Fixed

- **Import bundle now persists every environment**, not just the last one. `applyBundle` was rebuilding `environments.json` from a stale snapshot on every iteration, so importing a 7-env bundle showed up as 1 env in the registry (the `.env` folders were created for all 7, but the UI only saw the last). Now mutates a working list in place and saves after each entry. Regression test added.
- **Dashboard and Environments pages now force-dynamic** so the env list is read from disk on every request instead of being served from a stale RSC cache after an import or edit.
- **Lowered the export passphrase minimum from 12 to 6 characters** across the encrypt path, the `/api/environments/export` validator, the EnvExport modal client check, and the placeholder text.
- **Release fetch errors that are really shape/parse warnings** (server reachable, payload didn't match) now render in amber as `release warning:` instead of red `release fetch failed:` on both the Dashboard `EnvCard` and the Environments tab `ReleaseStrip`. Adds an inline **Retry** chip and treats any cached `release.json` error as stale so the auto-refresh doesn't get stuck red until the next UTC day.
- **Environments toolbar polish**: Export/Import/Backups buttons now use the shared `.btn-secondary` theme; Import = `ArrowDownToLine`, Export = `ArrowUpFromLine` icons.

## [0.2.6.7] - 2026-05-12

### Added

- **Environment export & import** on the Environments tab. A new toolbar exposes three actions:
  - **Export…** — choose any subset of environments and one of three secret-handling modes: redact (recommended for sharing — `SERVICE_ACCOUNT_KEY`, `RCS_PRIVATE_KEY`, `*_TOKEN`, `*_PASSWORD`, etc. are replaced with `<REDACTED>`), include plaintext (treats the bundle as sensitive), or **AES-256-GCM passphrase encryption** (PBKDF2-SHA256 / 200,000 iterations / shared salt across the bundle so a single passphrase derivation decrypts every env). The download is a single JSON bundle following schema `pinghub-environments/v1` and includes the per-env `environments.json` metadata, `.env`, `log-api.json`, `rcs-status.json`, and `release.json`. Filenames are stamped `pinghub-envs-<host>-<ts>[-secrets|-encrypted].json` and the response carries an `X-PingHub-Bundle-Sha256` integrity header.
  - **Import…** — drop in a bundle and pick per-env actions (Skip / Replace / Rename). Replace shows a warning that the live env will be auto-backed up first. When the bundle has redacted secrets, a per-row **Keep live secrets where bundle is redacted** toggle (default ON) merges live secrets back in so importing a redacted bundle never loses real credentials. Encrypted bundles prompt for the passphrase. Writes are atomic on Windows: each env stages to `.{env}.import.tmp/`, the existing folder is renamed aside, the staged folder is promoted, and a rename failure rolls back the side-lined original.
  - **Backups** — every overwrite first writes a full plaintext-secret snapshot to `environments/.backups/<env>-<YYYYMMDD-HHMMSS>.json`. The backups dialog lists snapshots grouped by env, with download / delete actions, and a **Prune old** button that keeps the 10 newest per env and discards anything beyond 7 days. The `.backups/` folder is git-ignored, as are exported `pinghub-envs-*.json` files at the repo root.
  - All three actions emit op-history entries (`env-export`, `env-import`, `env-backup`).
## [0.2.6.6] - 2026-05-12

### Added

- **Monitor section** consolidating health and certificate status. A new top-level **Monitor** nav item replaces the standalone **RCS Status** entry and surfaces three sub-tabs:
  - **Server Status** — configurable HTTP health checks for arbitrary URLs, grouped by user-defined sections. Each monitor supports custom method, timeout, headers, auth (none / basic / bearer), insecure-TLS opt-in, JSON-path status extraction, healthy/degraded regex, and `bodyContains` substring assertions for HTML landing pages. Results render with colour-coded dots (ok / degraded / down / unknown), per-row last-checked timestamps, an overall summary banner with worst-status pill and counts, and a right-side detail drawer that shows the response body snippet. A red **warning banner** is shown whenever any monitor is `down` (and optionally when any monitor is `degraded`, via the new **Ignore degraded in warnings** toggle which defaults to on). Auto-refresh, refresh interval (15s–7d), the ignore-degraded toggle, and the last set of results are all persisted to `localStorage` via a new `usePersistentState` hook so toggling settings or reloading the page no longer clears status.
  - **TLS Expiration** — new sub-tab that opens a raw `tls.connect` to each configured target, captures the peer certificate (without enforcing trust, so expired/self-signed certs can still be reported), and surfaces expiry date, days remaining, issuer CN, SAN list, SHA-256 fingerprint, and serial number. Targets are classified as `ok` / `warning` (≤ 30 days by default) / `expired` (≤ 7 days or already past) / `error`, each with its own colour. A red banner highlights any expired/error certificate; warnings render in amber. Editor supports per-target warn/critical day thresholds and an optional SNI servername override. Seeded with the five Tenant SSO/AM/IG endpoints.
  - **RCS Status** — the existing Remote Connector Server matrix, now reachable at `/monitor/rcs-status` (legacy `/rcs-status` redirects). Gains the same auto-refresh + interval controls (with a shared 15s–7d option list reused across all three sub-tabs), a summary banner with last-checked timestamp, and per-environment last-checked indicators.
- **HTTP check engine** in `src/lib/monitors/check.ts` built on node's `http`/`https` modules (no extra deps). Handles `/health/live`, `/health/ready`, `/openig/ping`, JSON status fields (`status`, `state`, `health.status`, `live`, `ready`, etc.), HTML landing pages via `bodyContains`, and plain-text bodies; classifies network failures (DNS, ECONNREFUSED, timeout, TLS) into structured error messages.
- **TLS check engine** in `src/lib/monitors/tls-check.ts` using `tls.connect({ rejectUnauthorized: false })` so the check itself never fails on expired or untrusted chains — it inspects the cert regardless and reports the issue.
- **Persistent UI state hook** `src/hooks/usePersistentState.ts` (strict-mode-safe via a `useState`-backed `loaded` flag) used by all three sub-tabs to remember auto-refresh, intervals, results, and the ignore-degraded toggle across reloads.

### Changed

- `NavBar` now shows **Monitor** in place of **RCS Status**; the old route 302s to `/monitor/rcs-status` for back-compat.
- `environments/monitors.json` and `environments/tls-monitors.json` follow the existing `rcs-status.json` pattern (gitignored, per-deployment local config). Both can be edited from the in-app **Edit configuration** UI.

## [0.2.6.5] - 2026-05-12

### Fixed

- **Logs → JSON view: scroll-to-selection no longer leaves the viewport pinned at the top.** Two related bugs prevented JSON view from scrolling to the row a user had clicked in terminal/table view when entry counts were large (5k+).
  1. **Auto-tail race.** The JSON viewer's auto-tail effect was declared before the scroll-to-selection effect, and `atBottomRef` defaulted to `true` on mount. On view switch, auto-tail fired first and called `virtualizer.scrollToIndex(entries.length - 1, { align: "end" })`, immediately yanking the viewport to the end and overriding the scroll-to-selection convergence loop that ran next. Subsequent tail polls kept re-firing auto-tail, never letting selection win. Fix: initialise `atBottomRef` to `false` when a scroll-to-selection request is pending on mount, and gate auto-tail with a new `scrollLoopActiveRef` that the rAF convergence loop sets while in flight.
  2. **`virtualizer.getOffsetForIndex` returning `0` for far-off unmeasured rows.** With our custom scroll element (we feed react-virtual our internal `virtualOffset` via `observeElementOffset` instead of `el.scrollTop`), `getOffsetForIndex(idx, "center")` returned `[0, ...]` for rows millions of pixels down, so `if (got) target = got[0]` pinned the convergence loop at offset 0 until it bailed on stable. Fix: drop the `getOffsetForIndex` call entirely in the convergence loop and always proportional-jump (`(idx / count) * max`) when the row is not yet in the DOM; the precise `rowRect`-based path takes over once measurements come in.
- **Logs → JSON view: scrolling near the middle no longer blanks the viewport.** With 50k+ entries and totalSize > 30M px, the previous renderer translated the whole row container by `translateY(-virtualOffset)` and then positioned each row at `translateY(vi.start)`. Browser compositors use float32 for transform offsets and start clipping / blanking once values cross ~16M (2^24, the float32 integer-precision threshold). Fix: remove the parent translate entirely and position each item with `top: vi.start - virtualOffset`, which always stays within ±viewport regardless of scroll position. The large `totalSize` now lives only in JS (scrollbar math), never in the DOM.

## [0.2.6.4] - 2026-05-11

### Added

- **Browse → Compare for journeys and IGA workflows (Phase 3 of file-version history).** Multi-file items like journeys and IGA workflows can't use the per-file Compare dropdown introduced in 0.2.6.0–0.2.6.2, because a "journey" on disk is really a directory of node JSONs (plus referenced scripts and inner journeys) and a workflow is a folder of step files. The Sections-view header for these scopes now exposes a **Compare versions** button that:
  1. Lists commits that touched **any** file under the item's directory via a new `GET /api/configs/[env]/item-history?scope=&item=` endpoint (uses `git log -- <path1> <path2>...` across all affected paths; no `--follow` since that's incompatible with multi-path log).
  2. Lets the user pick **A** and **B** slots (working tree or any commit) with the same UX as the per-file picker.
  3. On submit, calls a new `POST /api/configs/[env]/item-compare` which materialises each requested SHA into a temporary detached git worktree under the system temp dir (new helper `src/lib/git-worktree.ts`), runs the existing `buildReport` diff engine against the matching `<configDir>` inside each worktree (forcing the journey into the result via `forceIncludeJourneys` so unchanged journeys still produce a tree), then trims the report to files relevant to the chosen item (the journey itself, its sub-journeys, any scripts pulled in by dependency resolution; or `iga/workflows/<item>/` for workflows). Worktrees are cleaned up in `finally` (`git worktree remove --force` + `fs.rmSync` + `git worktree prune`).
  4. Opens the existing `JourneyDiffGraphModal` (journeys) or `WorkflowDiffGraphModal` (workflows) — the same unified visual diff used on the Compare tab — so the user lands directly in the rich graph view they already know. If two semantically-equal versions are picked, a small "no changes detected" dialog appears instead of an empty graph.
- New reusable component `src/components/ItemComparePanel.tsx` encapsulates the item-level history fetch, slot picker UI, compare invocation, and modal selection.

### Changed

- `src/lib/git-history.ts` gains `listMultiPathCommits(repoRelPaths, limit)` — used by the new item-history endpoint to gather commits that touched any path within the item directory in a single `git log` invocation.

### Fixed

- **Browse → Sections view: script files no longer collapse to zero height (no scrolling).** The Content wrapper around the version-picker body was `flex-1 overflow-hidden min-h-0` but wasn't itself a flex container, so the inner `flex-1 min-h-0` wrapper around `versionUi.bodyNode` had no resolved height. `ScriptFileViewer` (and `JsonFileViewer`) use `h-full` internally, which resolved to 0 — the file rendered but had no scrollable viewport. Adding `flex flex-col` to the Content div restores the height chain.

## [0.2.6.3] - 2026-05-11

### Fixed

- **Logs → Transaction-ID search no longer leaks across tabs.** The traceId/transactionId input at the top of the Logs page is shared by all tabs, but each tab keeps its own results. Previously, the latest submitted search was delivered to *whichever tab happened to be active*, keyed only by a monotonic `seq`. That meant: search X in Tab A → switch to Tab B and search Y → switch back to Tab A, and Tab A's results got overwritten with Y's because its `prevTxSeq` was still behind. Each submit is now stamped with the originating `tabId`, and the search is only delivered to that specific tab — switching tabs no longer triggers a re-fetch.

## [0.2.6.2] - 2026-05-11

### Added

- **Browse → Sections view also gets Versions + Compare**: the file-version-history UI (introduced in 0.2.6.0 / 0.2.6.1) was previously only wired into the Tree view. It now also appears in the default **Sections** view header for any non-journey/non-workflow file (JSON, JS, Groovy, generic text). The two views share the same logic via a new reusable hook **`useVersionPicker`** in `src/components/VersionPicker.tsx`, which encapsulates the history dropdown, slot pickers, compare-mode state, and the rendering contract (it asks the caller to provide the single-version viewer and the compare-mode viewer, so JSON/JS/Groovy formatting and ESV decoding behave identically in Sections mode). Journey and IGA-workflow scopes still render their visual graphs and are intentionally excluded for now (see Phase 3 — dependency-pinned diff).
- **`DefaultCompareBody`** convenience component that wraps `FileDiffViewer` with the standard loading / error states for callers that don't need a custom compare renderer.

## [0.2.6.1] - 2026-05-11

### Added

- **Browse → Compare mode** (Phase 2 of file version history): the file viewer header now has a **Compare** button next to Versions. Compare mode shows two slot pickers — **A** (rose) and **B** (emerald) — each independently choosable from the same history dropdown (Working tree + up to 50 prior commits). A **⇄** button swaps slots; **✕** exits compare. Default on entry: A = Working tree, B = newest prior commit. The viewer body switches to a compact unified line diff with per-side line numbers, +/- gutter, syntax-aware formatting (JSON pretty-printed, JS/Groovy beautified), and a summary header (`+N -M`). Files larger than 2000 lines fall back to a "too large" notice instead of locking the browser.
- **`src/lib/client-diff.ts`** — shared client-side LCS line diff + content formatting, extracted from the Compare-page rendering pipeline.
- **`src/components/FileDiffViewer.tsx`** — the new compact diff viewer used by Browse compare mode.

## [0.2.6.0] - 2026-05-11

### Added

- **Browse → Versions dropdown** (Phase 1 of file version history): when viewing any file in the Browse tab, click the new **Versions** button in the header to see up to 50 commits from the env-repo that touched this file (with `--follow` so renames don’t truncate history). Each row is color-tagged by op kind (pull, push, promote, manual, auto, merge), and shows short SHA, timestamp, commit subject, and author. Picking a row swaps the viewer to that historical version and shows an amber “Viewing version `<sha>` from `<date>`” banner with a **Back to current** button. Hidden when the env-repo isn’t initialised. Compare and dependency-pinning land in Phases 2 and 3.
- **`GET /api/configs/[env]/file-history`** — returns `{ gitAvailable, repoRelPath, workingTreeExists, entries }` for a given config-relative path.
- **`GET /api/configs/[env]/file-at`** — returns `{ exists, content, sha, repoRelPath }` for a given path at a specific commit.

## [0.2.5.4] - 2026-05-10

### Added

- **Repo → Force push**: checkbox next to the Push button enables `git push --force-with-lease` (safer than `--force` — still refuses if the remote moved since your last fetch). When enabled, the button turns red and reads “Force push”. The flag is **not** persisted across page loads.
- **Repo → auto-detect non-fast-forward**: when a normal push is rejected (remote has commits you don’t have locally), the error message now explains the situation and a “Force push?” confirm dialog appears immediately, so you can retry with `--force-with-lease` in one click instead of having to manually toggle the checkbox.

### Fixed

- **Repo → unhelpful “git push failed: To <url>” error**: rejected pushes now surface the actual reason (non-fast-forward, stale `--force-with-lease` lease, etc.) instead of just the first stderr line from `git push --progress`.

## [0.2.5.3] - 2026-05-10

### Added

- **Repo → Push scope selector**: a chip list of every top-level environment folder under the target dir (auto-detected, e.g. `ide/`, `ide3/`, `prod/`, `sit/`, `uat/`) plus a "Root files" entry. Each chip shows a dirty-count badge. Default selection = everything (push-all). Selection persists in localStorage so the choice carries across reloads. The Push button label updates to `Push all` vs `Push (N)`. When scoped, the server runs `git add -A -- <paths> .gitignore` instead of `git add -A`, then commits and pushes the whole branch (other dirty files stay uncommitted).
- **Repo → live push progress**: the Push handler is now a Server-Sent Events stream. Each `git` command emits `step-start` / `progress` / `step-end` events, so the UI shows a live timeline with a spinner per running step, ✓/✗ once each completes, and a collapsible "Live output" pane streaming `git push --progress` line-by-line (counting objects, compressing, writing, etc.). A red **Cancel** button maps to `DELETE /api/git/push` which SIGKILLs the active git child server-side. A second Push request while one is in flight returns 409 instead of racing on the index.
- **`GET /api/git/envs`**: new endpoint listing immediate subfolders of the env target dir with per-folder dirty counts, used by the scope selector. `node_modules/` and `.git/` are skipped.

### Fixed

- **Repo → "git commit failed: Auto packing the repository for optimum performance"**: on a fresh repo with ~10k objects, `git commit` triggers `git gc --auto`, which writes the "Auto packing…" notice to stderr and exits non-zero on Windows even though the commit itself succeeded. The push pipeline now runs every git invocation with `-c gc.auto=0`, sets `gc.auto=0` on the env repo's local config, and double-checks the commit landed via `git log -1 --pretty=%s` if the exit code looks suspicious.

## [0.2.5.2] - 2026-05-10

### Fixed

- **Settings → Push reliability on Windows**: `runGit` now uses `spawnSync` with `shell: false` instead of joining argv into a single shell string, eliminating the broken single-quote escaping that caused both the spurious `fatal: invalid object name '--pretty=format'` in the commit-history panel and silent failures of any git command containing `:`, `%`, or spaces in its arguments.
- **Settings → "git add failed" on first push**: `git init` and every subsequent Push attempt now pin `core.autocrlf=false`, `core.safecrlf=false`, and `core.longpaths=true` in the env repo's local config, with `-c` overrides on `git add -A` as a fallback. Previously, users with `safecrlf=true` in their global git config saw `git add` exit non-zero on the CRLF warnings emitted for LF-formatted JSON pulled from ForgeRock, and journey nodes with long UUID-suffixed filenames blew past the Windows 260-character path limit with `Filename too long`.
- **Settings → stuck `index.lock` after a slow `git add`**: indexing 10k+ JSON configs on Windows can take several minutes; the previous 2-minute timeout left the spawned `git` process alive (Windows ignores `SIGTERM`), holding `.git/index.lock` and blocking every retry with `fatal: Unable to create '.git/index.lock': File exists.`. `runGit` now sends `SIGKILL` so timeouts actually terminate the child, the `git add -A` step gets a 10-minute budget, and Push proactively removes a `.git/index.lock` file older than 5 seconds before staging. A surviving lock now produces a plain-English error with manual-cleanup instructions instead of git's raw stderr.

### Changed

- **Repo page (formerly Settings)**: top nav tab renamed from "Settings" to "Repo". Page restructured into a sticky left rail (Connection settings) plus a right rail with three stacked cards: Repository (action bar + status badges + toast), Working tree changes (collapsible, auto-open when dirty), and Commit history (collapsed by default to cut visual noise).
- **Repo page error visibility**: every git action now surfaces the underlying stderr in the failure message (e.g. `git add failed: <real reason>`) and the toast renders an expandable "Show details" panel listing every git command that ran with its full stdout/stderr. Error toasts persist with a Dismiss button instead of vanishing after 4s.
- **Repo page action bar**: Pull / Commit all / Push moved to the top of the right rail beside compact branch / ahead / behind / dirty / clean status badges, so action results sit next to the buttons that triggered them.

## [0.2.5.1] - 2026-05-10

### Added

- **Settings → environments repo**: when initialising the environments folder as a git repo for the first time, PingHub now writes a default `.gitignore` that excludes pulled `managed-data/` (data.ndjson, index.sqlite, _manifest.json, _refs.json, .jobs/), per-env `.env*` credentials, the local `.op-log.jsonl`, and common editor / merge-conflict noise. The AIC config tree, `log-api.json`, `release.json`, `rcs-status.json`, and `environments.json` remain tracked. An existing `.gitignore` is never overwritten. The dirty-file count shown in the init confirmation dialog now respects the same patterns so it matches what will actually be staged.

## [0.2.5.0] - 2026-05-10

### Added

- **Logs configurable poll interval**: new "Poll every" dropdown in the tail toolbar (2 / 3 / 5 / 10 / 30 / 60s). Live-adjustable while tailing; restart preserves position. Persisted across sessions.
- **Logs Highlight Clear button**: mirror of the Filter Clear button. Clearing either now also collapses any auto-expanded rows in Table and Terminal-wrap views.

### Changed

- **Logs server-side level filter**: the UI level selection (ERROR / WARN / INFO / etc.) is now translated into an AIC `_queryFilter` on the tail and search requests, so DEBUG/FINE entries are dropped at the source. Reduces tail/search bandwidth ~10–100× on noisy environments and keeps the client from drowning in entries you've explicitly filtered out.
- **Logs tail backlog draining**: the worker's tail loop replaces `setInterval` with a self-rescheduling `setTimeout` chain. Each tick drains up to 25 pages with 1.1 s spacing, streaming each page to the UI as it arrives. Per-source generation guard + interruptible inter-page sleep makes stop/restart immediate. Eliminates lag accumulation when a backlog exceeds one page.
- **Logs JSON view virtualised**: switched to `@tanstack/react-virtual` with variable-height rows. Only entries in the viewport (+ overscan) are mounted, so cost is O(visible) regardless of total entry count. Per-entry stringified JSON is cached in a `WeakMap` keyed by entry reference, so `deepUnescapeJson` + `JSON.stringify` runs once per entry for the lifetime of the buffer. Switching to JSON view on a 50k-entry buffer is now instant.
- **Logs Copy JSON**: builds the document in 500-entry chunks with `await` yields, showing a live progress label and keeping the UI responsive on huge buffers.
- **Logs highlight searches full JSON**: Highlight match navigation now tests the entry's full JSON instead of only the formatted terminal line, so matches in payload fields hidden in Terminal view (visible in Table/JSON) are found and counted.
- **Logs auto-expand matching rows**: when Filter is active, every visible row in Table view auto-expands; when Highlight is active, every matching row auto-expands. Same behaviour in Terminal wrap mode.
- **Logs Export**: now always emits JSON regardless of the active view, expands nested stringified payloads via `deepUnescapeJson` so the file matches the JSON view's rendering, and adds a `-filtered` filename suffix when Filter or Level filter is active.

### Added

- **Find Usage for Managed Object types**: in the top-level Browse tab, selecting a Managed Object now exposes a "Find Usage" button that scans the env's local config tree for every reference to `managed/<type>` across journeys, the script library, custom-endpoint scripts, IGA workflows, sync mappings, managed-object hooks, schedulers, internal roles, IGA assignments/forms, access-config, and connector agents. Results are grouped by category and rendered in a dark-slate panel matching the existing scripts find-usage; rows are clickable links that navigate to the matching item in the configs viewer (where a clean scope mapping exists).

### Changed

- **Managed-data index moved to SQLite**: per-type browse and search now use a `index.sqlite` file alongside `data.ndjson` instead of an in-memory `_index.json` cache. Snapshots from before this release are auto-upgraded on first read; `_index.json` and `_offsets.json` are no longer written. Embedded (`better-sqlite3`) — no new services. Legacy per-`{id}.json` snapshots continue to work unchanged.

## [0.2.3.1] - 2026-04-27

### Added

- **Logs boolean queries**: Filter and Highlight boxes now accept `&&`, `||`, `( )`, `"phrase"` and treat whitespace between terms as implicit AND (Splunk/Lucene/KQL convention). Comma is still accepted as `||` for backwards compatibility.
- **Logs Search keywords field**: search mode now exposes a dedicated server-side keywords box (sent to AIC as `_queryFilter`), separate from the client-side Filter and Highlight boxes. Press Enter to launch a search.
- **Logs per-field Aa/[W] toggles**: each input (Search keywords, Filter, Highlight) has its own case-sensitive and whole-word toggles inline. Auto-highlight unions terms from all three fields so anything you type anywhere gets coloured in the rendered results.
- **Logs Expand all / Collapse all** buttons in terminal + wrap view, for bulk expansion of line-clamped entries.
- **Logs custom range validation**: warns and disables Search when the end time is before the start time.

### Changed

- **Logs toolbar reorganized into three rows by purpose** — Acquire (mode, time, Search/Stop, Keywords) · Query (Filter, Highlight, match navigator) · View (Terminal/Table/JSON, Wrap, Auto-scroll, Dedupe, counts, export). Removes the duplicate Aa/[W] cluster that previously appeared on two rows.
- **Logs progress dates** now render in local time (no more spurious roll-forward to the next day when local time is late evening).

### Removed

- **Logs History button** and the search-history panel in the log explorer toolbar.

### Fixed

- React key collision in the terminal nowrap view that made dedupe rows appear duplicated when the active match changed.

## [0.2.3.0] - 2026-04-27

### Added

- **Logs context tabs**: double-click any log entry to open a new tab showing a ±5 second window of surrounding entries, with the anchor entry highlighted in violet. Tabs preserve their state across navigation and tab switches.
- **Logs match navigation across all views**: unified "previous/next match" stepper with counter (`N / M`) works in terminal, table, and JSON views; jumps to the right page in table view and scrolls the right entry block in JSON view. Active match flashes amber and auto-expands.
- **Logs JSON view auto-unescape**: deeply unescapes JSON-encoded strings inside log payloads, including embedded JSON inside text-prefixed messages (e.g. `SEVERE: [uuid] Content: {…}`), so nested objects render as readable JSON instead of escaped strings.
- **Logs auto-scroll toggle** and a tail buffer increased to 500K entries; **stop button** for in-flight searches; time-based search **progress bar** with percentage.
- **Logs timezone selector** (local / UTC / epoch); datetime-local inputs now include seconds (`step=1`) for precise ±5s context ranges.
- **Data browse — dependencies panel**: shows outgoing and incoming references for the selected record, with a `_index.json` ref index built at pull time and lazy-loaded on demand.
- **Data browse — draggable splitter** between record list and detail pane (matches the search page).
- **Data pull freshness check**: probe counts are validated before a pull starts so stale snapshots aren't silently overwritten.
- **Search page**: draggable split and fast-path tooltips.

### Changed

- **Logs terminal styling**: zebra striping with darker dividers, color-coded fields (timestamp, source, level, message), neutral text colors for log messages, and line-clamp ellipsis instead of hard vertical cut in wrap mode. Wrap-mode entries gained a copy button and truncation for long payloads.
- **Logs persistence**: removed IndexedDB persistence and auto-save — tabs now hold logs in memory only, eliminating storage growth and reload latency.
- **Dev server**: switched to Webpack dev mode and excluded `environments/` from the watcher; the `environments/` directory was moved outside the project root for fast Turbopack/Webpack compilation.
- **Promotion internals**: extracted promotion dependency expansion and selection helpers into reusable modules; expanded journey tree report tests and added compare-route + journey-graph navigation regression coverage.

### Fixed

- **Logs match navigation key collision**: in nowrap terminal mode, the active match row's React key (`flashKey`, an incrementing integer) could collide with another row's index key (`absIdx`), causing deduped rows to appear duplicated or with wrong content/badges after a few next/prev clicks. The flash key is now a string (`flash-N`).
- **Logs lost on tab switch**: `txSearch` effect re-fired on tab switch and wiped fetched entries; now guarded with a sequence ref and per-tab config updaters are stabilized so inactive tabs keep their state.
- **Logs match navigation during tailing**: stabilized so the active match no longer drifts as new entries stream in.
- **Logs context tab fetch**: simplified to a ±5s time window after several iterations on the entry-count approach (server-filtered prefetch was incorrect, then sliced incorrectly, then unfiltered with too many entries).
- **JSON view embedded JSON**: `findJsonStart` now matches the opening delimiter to the string's ending delimiter, so trailing `}` correctly anchors to the first `{`.
- **Inner journey diff graph**: corrected node statuses for nested journeys.
- **Journey dependencies report**: missing dependencies are now reported instead of silently dropped.

## [0.2.2.1] - 2026-04-23

### Added

- **RCS Status** (`/rcs-status`): new matrix page showing RCS health per cluster and instance across every environment. Cluster/instance status is derived from `POST /openidm/system?_action=testConnectorServers` (one call per env, each RCS's `ok` drives the cluster aggregate: ok/degraded/down/empty). The drawer lists member instances with per-instance Connected/error and a secondary "IDM Connector integration probes" section that runs `_action=test` per connector and supports a per-cluster watchlist (real-time save, checkboxes). Environment columns can be skipped via a column-header checkbox persisted in `environments/rcs-env-skiplist.json`. Group-by-type and Hide-unused toggles.
- **Release info per environment**: Dashboard and `/environments` env cards show the tenant's current AIC platform version, release channel (regular/rapid), and next scheduled upgrade, fetched from `GET <tenant>/environment/release`. The Dashboard also shows an "Upcoming AIC upgrades" banner (amber / rose) for envs whose upgrade is within 7 days or overdue. Refresh is automatic once per UTC day — kicked off in the background on any page render.

### Changed

- `connectorHostRef` is now correctly read from `connectorRef.connectorHostRef` (the real AIC shape). Direct-instance refs that are members of a cluster are correctly typed as `client` / `server` rather than `clientGroup`.

## [0.2.1] - 2026-04-22

### Fixed

- **ESV precheck**: rewrote against the spec — runs after dry-run dependency resolution, scans only files that will actually land on the target (`added` / `modified` in the report), and looks up defined ESVs on the live tenant via `GET /environment/{variables,secrets}` when the target is remote instead of a potentially-stale on-disk snapshot.
- **ESV reference detection**: `extractNamedRefs` now covers `identityServer.getProperty(…)` in addition to `systemEnv.*`, and ignores non-ESV platform property lookups (e.g. `identityServer.getProperty("openidm.idpconfig.*")`) that were previously flagged as missing.
- **Compare item filter**: made the per-item regex scope-aware via `pathToScopeItem`. A task selecting endpoint `le-test` no longer false-matches an unrelated journey `alpha/journeys/le-test/le-test.json` during verify-compare.
- **Data pull on Windows**: atomic-swap renames (`.pulling-<id>/<type>` → `<type>`) are retried with backoff so transient `EPERM` / `EACCES` / `EBUSY` locks from file watchers or antivirus don't fail the pull after every record has been fetched.
- **Data pull jobs**: stuck `running` entries are cleaned from the registry so a crashed or abandoned pull no longer blocks future pulls on the same type.

### Added

- **Promote gate**: the "Promote" stepper dot and the "Next: Promote" arrow are disabled whenever the ESV precheck lists missing entries, with a tooltip explaining which ESVs to define on target first.

### Changed

- **Data browse / configs**: async file I/O throughout, loading skeletons while the tree loads, page-slice reads for managed data (so scrolling doesn't read the whole type), and a `_index.json` built at pull time and cached in memory for snapshot browsing.

## [0.2.0] - 2026-04-22

### Added

- **Data tab**: browse managed-object snapshots and run on-demand data pulls. Per-type record tables, detail pane, display-field inference, JSON export, shared env pill, last-pulled age, ETA, idle banner, and a persistent `GlobalJobBanner` that surfaces in-flight background jobs across navigation.
- **Direct-control (DCC) promote flow**: controlled environments now promote in-process through a Direct Configuration Change session — lock → dry-run → push (with `X-Configuration-Type: mutable`) → apply → pull-target → verify — with DCC phases surfaced as their own log sections. Stale sessions are detected and closed before push; apply polling defaults to 2-second intervals with a 20-minute timeout for tenant restarts.
- **Item-level checkboxes on every scope** in the promote task editor, including DIR-based scopes (email-templates, connector-mappings). Scope headers show a tri-state indicator (unchecked / indeterminate / checked), and the picker gained +/- resize plus fullscreen controls, mirroring the logs view.
- **Token-acquisition progress** narrated per request (`[token] → POST …`, `✓ token acquired …` with TTL and granted scopes), routed to stdout so clean runs don't surface it as errors.
- **restClient retries** network errors with decorated messages; a 60-second timeout is applied to AIC requests and browser stream drops are labeled.
- **Environments manager**: in-process tenant restart and DCC, consolidated edit-modal header, unified test/poll/restart terminal with Stop repositioned, close allowed while polling.

### Changed

- **Analyze tab simplified**: the journey dependency tree, force-directed journey/script map, and managed-object schema graph were explored, then removed. The tab now hosts only **ESV orphan references**, dropping the `react-force-graph-2d` dependency and ~1800 lines of dead code.
- **Promote task creation**: adding an email-template or connector-mapping file from a compare result now scopes the task to that single item instead of the whole scope.
- **Scripts pull** batches by item and matches by `name` OR `_id`, with duplicate filter forms no longer producing false "not found" reports.
- **Logs tail** no longer yanks the viewport when new entries arrive while the user is inspecting a highlighted keyword; a successful batch clears any stale fetch-error banner beside the entry count.
- **DCC push order**: scripts go before journeys so journey nodes can resolve their script references on first apply.
- **Managed-objects push** always runs per-name to preserve the GET → splice → PUT merge flow.
- **vendor/iga-workflows** treats an empty workflow list as success instead of an error.
- **vendor/auth-trees** logs the PUT URL per node + tree for clearer push diagnostics.

### Fixed

- **Promote scope remapping**: dir-based scopes (email-templates, connector-mappings) now key the `_id` remap by directory name instead of `json.name`, so a copy that inherits the original's `name` field no longer collides onto the original on the target tenant.
- **Streaming responses**: double-close crash removed, dev-server response buffering defeated with periodic heartbeats, and aborts are no longer re-issued while one is already in flight.
- **Tenant restart**: `_action` is passed as a query parameter for compatibility.
- **Search tab**: hydration mismatch resolved by deferring the `localStorage` rehydrate to post-mount.
- **Pull prune**: recognizes both realm on-disk layouts (`realms/<realm>/<subdir>/` and `<realm>/<subdir>/`) so remote deletions propagate locally.

## [0.1.0] - 2026-04-20

First public release of PingHub under the Apache License 2.0.

### Added

- Web UI for Ping Advanced Identity Cloud config management.
- **Pull**: streaming-log pull for 40+ config scopes (journeys, scripts, IDM managed objects, endpoints, IGA applications/entitlements, SAML, CSP, themes, and more).
- **Push**: push local config back to a tenant, with production-only confirmation.
- **Promote**: multi-phase promotion workflow — lock, dry-run diff, review, promote, verify, unlock, rollback.
- **Journey viewer**: interactive ReactFlow graph plus outline, table, swim-lane, and JSON views. Inline node details, script overlay, search, trace upstream/downstream/data paths, fold passthrough chains, ELK or dagre layouts.
- **Semantic journey diff**: compare journeys across environments with a canvas that highlights added / removed / modified / unchanged nodes, side-by-side script diffs, and inner-tree navigation.
- **Environments manager**: guided tenant-add wizard, raw `.env` editor, tenant connection test.
- **Search / analyze**: global search across scopes; find-usage for scripts, endpoints, and inner journeys.
- Vendored subset of [`fr-config-manager`](https://github.com/ForgeRock/fr-config-manager) under `src/vendor/` (MIT licensed — see `NOTICE`).
- Apache 2.0 license, project metadata, `SECURITY.md`, `CODE_OF_CONDUCT.md`.

[Unreleased]: https://github.com/bostonidentity/PingHub/compare/ping-aic-studio/v0.2.1...HEAD
[0.2.1]: https://github.com/bostonidentity/PingHub/compare/ping-aic-studio/v0.2.0...ping-aic-studio/v0.2.1
[0.2.0]: https://github.com/bostonidentity/PingHub/compare/ping-aic-studio/v0.1.0...ping-aic-studio/v0.2.0
[0.1.0]: https://github.com/bostonidentity/PingHub/releases/tag/ping-aic-studio/v0.1.0
