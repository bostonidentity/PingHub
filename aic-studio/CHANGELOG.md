# Changelog

All notable changes to AIC Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (M4-M6 — UI completions: compare extras, history, promotion tasks polish)

- `aic-studio.compare.withRevision` — compare a journey against an older snapshot of the same env
- `aic-studio.compare.pickEnvs` — palette command to compare any two envs / journey
- HistoryTreeProvider populates the History sidebar (replaces M1 placeholder); grouped by day
- `aic-studio.history.openDetails` opens a read-only document with full op metadata
- Promotion Tasks tree adds an "Archived" expandable root
- `aic-studio.promote.removeItem` and `aic-studio.promote.deleteTask` commands
- `op_history` records `target_env` for push/promote (schema migration v4)
- Snapshot helpers: `listAllSnapshotsForEnv`, `readJourneyFromSnapshot`
- 7 new integration tests (26 total); ~5 new unit tests (~75 total)

### Added (M3 — push & promote)

- `aic-studio.sync.push` command — right-click a journey, push to another env
- Promotion tasks (`promotion_tasks` table, schema migration v3) — group journeys, push as a batch
- `aic-studio.promote.addToTask` / `runTask` / `archiveTask` commands
- Promotion Tasks sidebar view becomes functional (replaces M1 placeholder)
- SCM Changes group populated from snapshot diff (latest pull vs previous pull)
- AIC client gains `put()` method; `putJourney()` core helper
- `pushPromotionTask` orchestrates multi-item push with continue-on-failure
- `op_history` records every push + promote operation
- 5 new integration tests (19 total); ~13 new unit tests

### Added (M2 — pull, virtual docs, diff editor)

- OAuth client_credentials auth against AIC (`/am/oauth2/realms/root/access_token`)
- In-memory token cache with 30-second expiry grace
- List realms + list/fetch journeys via direct AM REST API
- `aic-studio.sync.pull` command pulls all journeys from all realms of an env
- Snapshots written as flat JSON to `globalStorageUri/snapshots/<env>/<timestamp>/<realm>/journeys/<id>.json`
- `op_history` SQLite table records each pull (schema migration v2)
- Environments TreeView expands to show realms → Journeys (N) → individual journeys
- Clicking a journey opens it as an `aic://` virtual document in the editor
- `aic-studio.compare.withEnv` command opens the built-in `vscode.diff` between two envs
- SourceControl provider registered per env (Changes group empty in M2; M3 populates it)
- Status bar spinner during pull
- 6 new integration tests (12 total); 35 new unit tests (54 total)

### Added (M1 — scaffold & environments)

- Project scaffold: TypeScript, esbuild, vitest, @vscode/test-electron, ESLint
- PingHub activity bar icon
- Five sidebar TreeViews (Environments + 4 placeholders)
- SQLite-backed environment storage at `globalStorageUri/pinghub.db`
- `SecretStorage`-backed credentials (password, client secret, log API key/secret)
- Commands: `aic-studio.env.add`, `aic-studio.env.setActive`, `aic-studio.env.remove`
- Status bar item showing active environment
- CI workflow on 4 OS targets
- Insiders publish workflow (drafted, awaiting secrets)
