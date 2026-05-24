# AIC Studio — VS Code Extension Design

**Status:** Design approved · ready for implementation planning
**Date:** 2026-05-24
**Project:** `aic-studio/` (new) — replaces `aic-pipeline/` (Next.js web app)
**Author:** Brainstormed with Claude Code

---

## Summary

Rewrite the PingHub `aic-pipeline` Next.js web app as a **native VS Code extension** called **AIC Studio**, published to the VS Code Marketplace as `bostonidentity.aic-studio`. The extension becomes the sole way to use PingHub for AIC tenant configuration management — the web app is sunset and removed from the monorepo after a 60-day deprecation window.

The extension prioritizes native VS Code primitives (TreeViews, Source Control API, the built-in diff editor, virtual documents) over webviews. Seven webviews remain for surfaces that have no native equivalent: Dashboard, Journey Graph, Monitor Dashboard, Federation Editor, Analyze (find usage), Promote Wizard, and Logs Query.

---

## Goals and non-goals

### Goals

1. **Easier distribution.** Users install one extension from the marketplace — no Node, no `npm run dev`, no hosting.
2. **Feature parity at v1.** All 14 current top-nav pages (Dashboard, Sync, Browse, Federation, Compare, Promote, Analyze, Data, Logs, Search, History, Environments, Monitor, Repo) reach parity before any user-visible release.
3. **Native VS Code UX.** ~85% native (sidebar trees, SCM panel, diff editor, virtual docs, command palette); ~15% webview only where unavoidable.
4. **Single source of truth.** The extension owns its business logic directly under `src/core/`; no shared package with the legacy web app.

### Non-goals

- Backwards compatibility with the web app's SQLite schema or data on disk. **Fresh start** at first install.
- Workspace-scoped environments. Envs are **global to the user**.
- Browser-runnable variant. Extension targets VS Code desktop only.
- Custom code-signing or notarization. Marketplace handles distribution; no installers ship outside it.

---

## High-level decisions (from brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Target | VS Code (not full Visual Studio) | Existing app is JS/React; extension model maps well |
| Approach | Native rewrite (not webview-wrap) | Justifies the long build with a product that feels native |
| Env scoping | Global to the user | Matches web app's standalone nature |
| v1 scope | Full parity before release | Clean cutover, no half-product in the wild |
| Data migration | None — fresh start | Simplest; agreed users will re-add envs |
| Web app | Sunset entirely after v1.0 | Extension replaces; aic-pipeline/ deleted post-deprecation |
| Layout | Native VS Code primitives | Top-nav goes away; 14 pages map to 5 sidebar views + 7 webview panels + SCM/diff/command-palette homes |
| Insiders channel | Yes, from day one | Boston Identity engineers dogfood ahead of public release |

---

## 1. Architecture & repo layout

### Repo structure during build

```
PingHub/
  aic-studio/                  ← NEW: the extension
    src/
      extension.ts             activation, command registration
      core/                    business logic (VS Code-free, fully unit-testable)
        aic/                   AIC HTTP client (ported from src/lib/fr-config.ts et al.)
        db/                    SQLite schema + queries (better-sqlite3)
        promotion/             promote orchestration
        analyze/               find-usage / managed-object usage
        compare/               diff logic (ported from src/lib/diff.ts, journey-diff-graph.ts)
        env-bundle/            export/import (ported from src/lib/env-bundle*.ts)
        federation/            federation config logic
        monitors/              health / TLS / RCS checks
        logs/                  AIC log query
        git/                   optional git-history integration
      providers/
        envTree.ts             TreeDataProvider for Environments view
        promotionTasksTree.ts  TreeDataProvider for Promotion Tasks view
        historyTree.ts         TreeDataProvider for History view
        monitorsTree.ts        TreeDataProvider for Monitors view
        logsTree.ts            TreeDataProvider for Logs view
        sourceControl.ts       one SourceControl per env (dynamic)
        virtualDocs.ts         TextDocumentContentProvider for aic://
      commands/                one file per command group (env, sync, promote, compare, analyze, view, search)
      webviews/
        host/                  extension-side message-bus wiring
          bridge.ts            shared Zod schema (extension ↔ webview contract)
        ui/                    React bundles, one per webview
          dashboard/
          journey-graph/
          monitor-dashboard/
          federation-editor/
          analyze-find-usage/
          promote-wizard/
          logs-query/
      status/                  status bar items
      logging/                 OutputChannel wrapper
    media/                     icons, codicons mapping
    tests/
      fixtures/                ← ported from aic-pipeline/tests/fixtures/
      unit/                    co-located with src/core/ as *.test.ts (vitest)
      integration/             @vscode/test-electron tests (~70 tests)
    package.json               contributes.{commands,views,scm,configuration,keybindings,menus}
    esbuild.config.mjs
    tsconfig.json
    vitest.config.ts
    .vscodeignore

  aic-pipeline/                ← STAYS during build, deleted post-cutover
  docs/superpowers/specs/      this design lives here
  docs/superpowers/plans/      implementation plan goes here next
```

### Process & runtime model

- Pure TypeScript extension. No embedded Next.js, no localhost server, no child Node processes (except when invoking `frodo` and `fr-config` CLIs, which the existing app already does).
- Runs entirely inside VS Code's extension host (Node).
- `better-sqlite3` is the only native dependency; ABI-matched against VS Code's Electron version, shipped per platform/arch.
- Activation event: `onStartupFinished`. Cold-start target <200ms; Dashboard panel auto-opens after activation.

### Tech stack

- TypeScript 5.x, ESM throughout
- `vscode` engine `^1.90` (modern SCM + Webview APIs)
- `better-sqlite3` for storage
- `axios` for AIC HTTP calls
- `jose` for JWT handling
- React 19 inside the 7 webviews
- `@vscode/webview-ui-toolkit` for theme-matching primitives in webviews
- `esbuild` for bundling
- `vsce` for packaging, `ovsx` for Open VSX
- `vitest` for unit tests, `@vscode/test-electron` for integration tests

### Layering boundaries

1. `src/core/` knows nothing about VS Code APIs. Pure functions + classes over data. Fully unit-testable with vitest using fixtures ported from `aic-pipeline/tests/fixtures/`.
2. `src/providers/`, `src/commands/`, `src/status/`, `src/logging/` are the only layers that import `vscode`. This keeps the core test surface clean and allows hypothetical re-hosting later.

---

## 2. UI mapping — top nav and sub-tabs

### 14 top-nav items → native VS Code homes

| Today's page | Native home | Detail |
|---|---|---|
| **Dashboard** | Webview Panel | Auto-opens on activation; shows env health, recent ops, alerts |
| **Sync** (pull/push) | SCM panel | Pull = refresh SCM; Push = SCM commit-like action |
| **Browse** | TreeView | Environments sidebar tree IS Browse; click config → opens as `aic://` virtual doc |
| **Federation** | Dedicated Webview Panel | Listed under each env in tree; opens a custom editing surface |
| **Compare** | Command + SCM panel | Right-click → "Compare with…" → native `vscode.diff` editor |
| **Promote** | SCM panel + Webview Panel | "Staged for promotion" in SCM + optional wizard panel for orchestration |
| **Analyze** (find usage) | Webview Panel | Rich cross-reference table; too dense for TreeView |
| **Data** (managed objects) | TreeView + Webview Panel | "Data" sub-tree per env; pull-and-browse opens as a panel |
| **Logs** | Webview Panel | AIC log query UI (search + filters + results) |
| **Search** | QuickPick | Cmd+Shift+P → "AIC: Search…" — filterable list |
| **History** | TreeView | Dedicated sidebar view; rows grouped by day |
| **Environments** | TreeView (main one) | Add/remove/edit via tree title actions + command palette |
| **Monitor** | TreeView + Webview Panel | Sidebar shows live status; drill-in opens dashboard panel (charts) |
| **Repo** (settings) | Native Settings | `contributes.configuration` — no custom UI |

**Result:** 5 sidebar TreeViews under one PingHub activity-bar icon + 7 Webview Panels opened on demand + palette commands and status-bar items. **No top-nav anywhere.**

### Activity Bar layout

```
PingHub (custom icon, "PingHub AIC Studio" tooltip)
└── 5 sidebar views (collapsible):
    ├── ENVIRONMENTS         (env tree → configs → realms → resource types)
    ├── PROMOTION TASKS      (active / archived)
    ├── HISTORY              (operation log, grouped by day)
    ├── MONITORS             (TLS, RCS, custom health checks)
    └── LOGS                 (AIC tenant log query results)
```

Per-env Source Control providers register dynamically via `vscode.scm.createSourceControl()`.

### Sub-tabs (pages like Monitor with 4 sub-views)

**Choice: sub-tabs inside the Webview Panel** (rendered as a tab strip just below the editor tab). Applies to:
- Monitor (Server Status / TLS Expiration / RCS Status / History)
- Data (Browse / Pull)
- Federation (multiple federation types)

**Fallback to "each sub-tab as its own VS Code editor tab"** only when the user wants side-by-side comparison (VS Code's split editor handles it for free).

### Virtual documents

URI scheme: `aic://<env>/<realm?>/<resource-type>/<id>?[rev=<git-sha>]`

Examples:
- `aic://prod-tenant/alpha/journey/Login`
- `aic://prod-tenant/federation/SAML2/sp-acme.json`
- `aic://prod-tenant/alpha/script/onLoginSuccess?rev=bfea7e6`

Registered via `TextDocumentContentProvider`. Read-only by default; the SCM panel handles changes. The `?rev=` query enables historical version viewing.

### Seven webviews (the only custom UI)

| Webview | Reason it must be a webview |
|---|---|
| Journey Graph | xyflow + dagre/elkjs interactive layout |
| Monitor Dashboard | recharts time-series, gauges, custom layout |
| Find Usage / Analyze | rich cross-reference table with grouping/filtering |
| Federation Editor | complex multi-form UI |
| Dashboard | summary cards + alerts grid |
| Promote Wizard | multi-step orchestration |
| Logs Query | search + filters + results table |

All use `@vscode/webview-ui-toolkit`; all communicate via the typed `postMessage` bus defined in `src/webviews/host/bridge.ts`.

### Status bar (left side)

- `$(globe) prod-tenant` — click → QuickPick to switch active env
- `$(sync~spin) Pulling…` — appears during ops
- `$(warning) 3 monitor alerts` — click → reveals Monitors view

---

## 3. Data & persistence

### SQLite at globalStorageUri

```
~/Library/Application Support/Code/User/globalStorage/bostonidentity.aic-studio/
  pinghub.db                  ← single SQLite file (better-sqlite3)
  snapshots/                  ← env config snapshots, flat JSON per pull
    prod-tenant/<timestamp>/alpha/journeys/Login.json
  bundles/                    ← exported env bundles (env-bundle-io)
  cache/                      ← transient (search index, etc.)
```

- One DB shared across all VS Code windows. Last-writer-wins on concurrent writes (acceptable for single-user tool).
- Schema ported intact from `aic-pipeline/src/lib/db/*` (no migrations needed — fresh start).
- Snapshots are **flat JSON files on disk**, not blobs in SQLite (easier to inspect, git-track, back up).

### Tables in SQLite

- `environments` — env definitions + non-secret config (tenant URL, username, client ID, color, label)
- `op_history` — pull/push/promote ops with timestamps + outcomes
- `promotion_tasks` — saved / active / archived promotion plans
- `monitors` — TLS check results, RCS status history
- `iga_cache` — IGA API responses for analyze/find-usage
- `git_index` — git-history metadata for the snapshots directory

### Credentials — hybrid SecretStorage + in-memory env composition

Today's web app stores per-env credentials in `.env` and `log-api.json` files on disk because it spawns `frodo` and `fr-config` child processes that need env vars. The extension preserves the env-var contract but routes secrets through VS Code's `SecretStorage` instead of disk:

```
SecretStorage keys                       SQLite columns
─────────────────────────────────────    ─────────────────────────────
aic-studio:env:<n>:password              env.tenantUrl
aic-studio:env:<n>:client-secret         env.username
aic-studio:env:<n>:log-api-key           env.clientId
aic-studio:env:<n>:log-api-secret        env.color, env.label, …
```

At spawn time:
1. Resolve non-secret config from SQLite.
2. Read secret values from `SecretStorage`.
3. Compose into a `{ KEY: value }` dict in memory.
4. `child_process.spawn(cmd, args, { env: { ...process.env, ...creds } })` — **no temp file**.

Drop-in equivalent of the existing `buildEnv()` in `aic-pipeline/src/lib/fr-config.ts:113`.

### Settings — `contributes.configuration`

```jsonc
{
  "aic-studio.autoOpenDashboard": true,
  "aic-studio.activeEnvironment": "prod-tenant",
  "aic-studio.snapshotRetention": "30d",
  "aic-studio.monitor.tlsThresholdDays": 30,
  "aic-studio.monitor.pollIntervalMinutes": 15,
  "aic-studio.logs.defaultPageSize": 100,
  "aic-studio.git.enabled": false,
  "aic-studio.git.repoPath": ""
}
```

### Workspace and global state

- `workspaceState`: last-active env per window, last-opened tab.
- `globalState`: install timestamp, telemetry consent, last-seen version.

### Activation sequence

1. Open or create `pinghub.db` at `globalStorageUri`.
2. Run schema migrations (idempotent — handles version upgrades; no-op on fresh install).
3. Resolve active env: `workspaceState` → `globalState` → first env in DB.
4. Initialize 5 sidebar TreeViews + per-env Source Control providers.
5. If `aic-studio.autoOpenDashboard` is true → open Dashboard Webview Panel.
6. Start background monitor polling.

---

## 4. Command surface & contributions

### Activation events

```jsonc
"activationEvents": ["onStartupFinished"]
```

### Command groups (~45–55 commands total)

Three representative entries per group; full list shipped with the implementation plan.

**Environment commands** (`aic-studio.env.*`)
- `add`, `edit`, `setActive`, `configureSecrets`, `remove`

**Sync commands** (`aic-studio.sync.*`)
- `pull`, `pullScope`, `push`

**Promote commands** (`aic-studio.promote.*`)
- `addToTask`, `openWizard`, `runTask`

**Compare commands** (`aic-studio.compare.*`)
- `withEnv`, `withRevision`, `snapshots`

**Analyze** (`aic-studio.analyze.*`)
- `findUsage`, `openPanel`

**View open** (`aic-studio.view.*`)
- `openDashboard`, `openFederation`, `openLogs`, `openMonitor`

**Search** (`aic-studio.search.*`)
- `configs`, `history`

**Internal/utility** (not user-visible)
- `_internal.refreshTree`, `_internal.openVirtualDoc`

### View containers and views

```jsonc
"viewsContainers": {
  "activitybar": [
    { "id": "aic-studio", "title": "PingHub AIC Studio", "icon": "media/icon.svg" }
  ]
},
"views": {
  "aic-studio": [
    { "id": "aic-studio.environments",     "name": "Environments" },
    { "id": "aic-studio.promotionTasks",   "name": "Promotion Tasks" },
    { "id": "aic-studio.history",          "name": "History" },
    { "id": "aic-studio.monitors",         "name": "Monitors" },
    { "id": "aic-studio.logs",             "name": "Logs" }
  ]
}
```

### Menu surfaces used

- `commandPalette` — all user-facing commands
- `view/title` — toolbar icons on each TreeView
- `view/item/context` — right-click on tree nodes (`when` clauses for relevance)
- `editor/title` — toolbar icons on `aic://` document tabs (Pull, Compare with…, Find Usage)
- `scm/title` and `scm/resourceState/context` — SCM panel actions

### Keybindings (minimal)

| Default | Command | When |
|---|---|---|
| `cmd+shift+enter` | `aic-studio.sync.push` | `scmProvider == aic-env && scmInputBoxFocus` |
| `f5` on tree node | `aic-studio.sync.pull` | `view == aic-studio.environments && viewItemKey` |

No reassignment of standard VS Code chords. Everything also accessible via the command palette.

### Naming convention

`aic-studio.<group>.<verb>` — namespaced, future-proof.

---

## 5. Build & distribution

### Build pipeline (esbuild)

Two entry-point sets in one esbuild config:
- `src/extension.ts → out/extension.js` (CJS, external `vscode`)
- `src/webviews/ui/*/main.tsx → out/webviews/<name>.js` (IIFE, bundled React + UI)

TypeScript handles type-checking only (`noEmit: true`). esbuild handles transpile. Production build target: <5s end-to-end.

### Packaging — platform-specific VSIXs

```bash
vsce package --target darwin-arm64
vsce package --target darwin-x64
vsce package --target win32-x64
vsce package --target linux-x64
vsce publish ...
ovsx publish ...
```

Each VSIX contains only the matching `better-sqlite3` binary. Target size: ~8MB per VSIX. Marketplace auto-serves the right one based on user's VS Code platform.

### Versioning & release cadence

- **SemVer.** v1 starts at `1.0.0`.
- **Quarterly ABI rebuild** when VS Code bumps Electron's Node version.
- **Auto-update** via VS Code's built-in extension updater. No installer, no code-signing, no notarization.

### CI/CD (GitHub Actions)

```
.github/workflows/
  ci.yml         PR: lint + typecheck + vitest + integration tests (matrix: 4 OS)
  release.yml    tag push: builds 4 VSIXs + publishes to marketplace + Open VSX + GH Release
```

`VSCE_PAT` and `OVSX_PAT` as GitHub secrets. Matrix: `macos-14` (arm64), `macos-13` (x64), `windows-latest`, `ubuntu-latest`.

### Publishing identity

- Publisher: `bostonidentity` (created prior to first publish).
- Extension ID: `bostonidentity.aic-studio`.
- Display name: "AIC Studio for Ping Advanced Identity Cloud".
- Marketplace listing: `aic-studio/README.md` (screenshots + install instructions).
- Icon: `media/icon.png` (128x128).

### Insiders channel (from day one)

Second extension ID `bostonidentity.aic-studio-insiders` published from `main` on every merge. Boston Identity engineers install both during the build phase. Version suffix: `1.0.0-insiders.N` during build, `1.1.0-insiders.N` during next-cycle work.

---

## 6. Testing strategy

Two layers map onto the two-layer boundary from §1.

### Unit tests — Vitest on `src/core/`

- Same runner as today (`vitest` already in `aic-pipeline/package.json`).
- **Fixtures ported directly** from `aic-pipeline/tests/fixtures/`.
- `nock` for AIC HTTP mocks.
- Coverage gate: **≥85% on `src/core/`**.

### Integration tests — `@vscode/test-electron` (~70 tests)

Three test classes:

**Golden-path tests (~12).** Happy flow end-to-end per workflow: pull → edit → compare → stage → promote → history reflects op.

**Rainy-day tests (~35 — the bulk).** Failure-mode coverage per workflow. Examples for sync:
- AIC returns 401 → re-auth prompt surfaces, no partial state
- AIC times out mid-pull → SCM Changes rolled back, OutputChannel logs reason
- Network drops between fetches → resumable, safe to retry
- Empty env → tree renders "no configs" state
- 5000+ config env → tree virtualizes, pull <30s
- Malformed JSON in AIC response → single item fails, others succeed
- SQLite locked → queues, no error
- SecretStorage returns null mid-flow → re-prompts for creds

Mirror for promote, compare, monitor, analyze.

**Cross-feature tests (~15).** Bugs that hide in feature interactions:
- Pull while monitor poll runs → no race
- Switch active env mid-promote → wizard cancels safely
- Delete env with pending task → confirm + cascade
- SCM provider survives window reload
- Virtual doc opened, then env removed → graceful "env not found"
- Two simultaneous pulls on different envs → both succeed, history ordered
- Activation with zero envs → empty state correct, CTA prominent
- Upgrade path: schema migrations idempotent across v1.0 → v1.1

**Regression suite (~8).** One test per shipped bug. Seeded from `aic-pipeline` changelog where reproducible.

### Webview tests — minimal

- `@testing-library/react` component tests, in-process. Ported from `aic-pipeline/tests/components/`.
- Bridge contract tests: a single Zod schema in `src/webviews/host/bridge.ts` is the source of truth; both ends validate.
- No Playwright-driven webview interaction tests for v1.

### Smoke test — manual pre-publish gate

Scripted scenario against a sandbox AIC tenant before each `vsce publish`:
1. Install fresh VSIX in a clean VS Code profile.
2. Configure prod-sandbox env.
3. Pull → assert N configs received.
4. Edit a journey locally.
5. Open compare → assert diff non-empty.
6. Promote to stage-sandbox → assert success.
7. Uninstall.

### CI matrix

```
matrix: { os: [macos-14, macos-13, windows-latest, ubuntu-latest] }
steps: install → typecheck → lint → vitest → vscode-test-electron
```

Native module rebuilt per-OS via `electron-rebuild` in `postinstall`. Expected ~8 min wall-clock per OS for the expanded suite.

### Coverage gates

- `src/core/`: ≥85% (vitest)
- `src/providers/` + `src/commands/`: ≥70% (via integration tests; lower bar because UI assertions are blunter)

### Process commitment

PR template asks: "What rainy-day test did you add?" Keeps the suite growing alongside features.

---

## 7. Cutover plan

### Five phases

```
   Today              v1.0 ships              +60 days
     │                     │                     │
     ▼                     ▼                     ▼
┌────────┐ ┌──────────┐ ┌──────┐ ┌─────────┐ ┌────────┐
│ Build  │ │ Insiders │ │ v1.0 │ │ Deprec. │ │ Remove │
│ phase  │→│ dogfood  │→│ ship │→│ window  │→│ web app│
│ 8–12wk │ │  2–3 wk  │ │      │ │  60 days │ │        │
└────────┘ └──────────┘ └──────┘ └─────────┘ └────────┘
```

**Phase 1 — Build (8–12 weeks).** Web app stays in production; feature freeze on `aic-pipeline/`. Bug fixes only. Extension milestones (one per sidebar view) ship to insiders as testable.

**Phase 2 — Insiders dogfood (2–3 weeks).** Boston Identity engineers install `bostonidentity.aic-studio-insiders` alongside the web app. Bug intake routed to `aic-studio:v1-blocker` label. Exit criteria: zero blockers + sign-off from ≥2 daily drivers.

**Phase 3 — v1.0 ship.** Tag `v1.0.0` → CI publishes 4 VSIXs to Marketplace + Open VSX. Announce in PingHub README, CHANGELOG, GitHub Discussions, internal Slack. Web app gets a sunset-banner release pointing at the extension.

**Phase 4 — Deprecation window (60 days).** Both products available. Web app: critical bug fixes only (security, data loss); all other intake redirected to extension. Mid-window check-in for stuck users.

**Phase 5 — Removal (after the 60-day window).** `aic-pipeline/` deleted in a single PR. Root `README.md` updated. Git history preserved.

### Versioning across the boundary

- Web app ends at `0.2.x`.
- Extension starts at `1.0.0`.
- Insiders pre-release format: `1.0.0-insiders.N`.

### Documentation migration

- `aic-pipeline/README.md` → relevant content into `aic-studio/README.md`.
- `aic-pipeline/CHANGELOG.md` → archived at `docs/legacy/aic-pipeline-changelog.md`.
- `aic-pipeline/docs/superpowers/` → archived at `docs/legacy/aic-pipeline-specs/`.
- Root `README.md` updated to point at marketplace install as primary entry.

### What users explicitly lose (agreed)

1. Existing SQLite history (op logs, saved promotion tasks).
2. Custom `--data-dir` layouts.
3. Multi-tab browser workflows (use VS Code split editor instead).
4. Web-app self-hosting on shared infra (extension is per-user-machine only).

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| v1 misses a workflow we forgot | Insiders dogfood catches it before public ship; 60-day window for patches |
| Native module ABI breaks on VS Code update | Quarterly rebuild cadence; insiders catches ~1 week before stable users |
| Org with no VS Code culture refuses to install an extension | Known incompatibility; recommend they fork `aic-pipeline` if needed |
| Insiders dogfood reveals architectural problems | This sectioned design + plan checkpoints should surface them earlier |

---

## Open questions for implementation planning

The following are not blocking spec approval but need decisions during plan-writing:

1. **Exact build milestone ordering.** Suggested order: scaffold + activation → Environments view → SCM/Sync → SCM/Promote → Compare/diff → History view → Promotion Tasks view → Federation webview → Monitors view + dashboard webview → Logs view + query webview → Analyze webview → Dashboard webview → Search/QuickPick → polish + Insiders publish → Sandbox smoke → v1.0.
2. **frodo and fr-config CLI bundling.** Today's app calls these as external CLIs. Options: (a) require user installs them globally, (b) bundle them inside the VSIX, (c) auto-install on first activation. Decide during plan-writing.
3. **Git integration scope at v1.** The web app has git-worktree, git-history, git-settings. Some of this assumes the user has a workspace folder open in VS Code; the extension is global. Decide what subset ports.
4. **Telemetry.** Decide opt-in/opt-out and what events. None included in this spec.

---

## Acceptance criteria for spec approval

- All seven sections in the design conversation are captured here.
- All decisions explicitly chosen by the user during brainstorming are reflected verbatim.
- No "TBD," "TODO," or placeholder language remains.
- Open questions are scoped to implementation-plan-time decisions, not unresolved design choices.

Spec is ready for user review and, on approval, transition to `superpowers:writing-plans`.
