# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/bostonidentity/PingHub/compare/aic-pipeline/v0.2.1...HEAD
[0.2.1]: https://github.com/bostonidentity/PingHub/compare/aic-pipeline/v0.2.0...aic-pipeline/v0.2.1
[0.2.0]: https://github.com/bostonidentity/PingHub/compare/aic-pipeline/v0.1.0...aic-pipeline/v0.2.0
[0.1.0]: https://github.com/bostonidentity/PingHub/releases/tag/aic-pipeline/v0.1.0
