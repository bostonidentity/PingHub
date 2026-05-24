# AIC Studio M11-M12 — Dashboard + Search QuickPick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two convenience surfaces:
- **M11 — Dashboard webview** auto-opens at extension activation (per `aic-studio.autoOpenDashboard` setting from M1). Summary panel showing per-env health, recent ops, alerts, snapshot freshness. Uses data already in `op_history`, `monitor_checks`, `environments` tables.
- **M12 — Search QuickPick** invoked from command palette: filter across all configured resources (journeys, scripts, federation items, saved log queries, promotion tasks). Fast in-memory search over snapshot indexes.

**Architecture:**
- **Dashboard:** New `webviews/ui/dashboard/` (React + recharts). Host queries SQLite + snapshot reader for stats; sends payload to webview. No new data layer.
- **Search:** Pure `vscode.QuickPick` UI populated from index built from snapshot trees + DB tables. No webview. Builds index lazily on first invocation; refreshes after pulls / promote.

**Branch:** `aic-studio/m11-m12` branched from `aic-studio/m10`.

---

## File Structure

```
aic-studio/
  src/
    core/
      dashboard/
        summary.ts                              NEW — buildDashboardSummary() — aggregates from DB + snapshots
        summary.test.ts                         NEW
      search/
        searchIndex.ts                          NEW — buildSearchIndex + queryIndex
        searchIndex.test.ts                    NEW
    commands/
      dashboard.ts                              NEW — openDashboard command
      search.ts                                 NEW — search command
    webviews/host/
      dashboardHost.ts                          NEW
    webviews/ui/dashboard/
      main.tsx                                  NEW
      App.tsx                                   NEW — summary cards + recent ops + monitor chips
      style.css                                 NEW
    extension.ts                                MODIFY — open Dashboard on activation (if config enabled); register search command
  package.json                                  MODIFY — add commands + keybinding
  esbuild.config.mjs                            MODIFY — dashboard webview bundle entry
  tests/integration/suite/
    dashboard.test.ts                           NEW
    search.test.ts                              NEW
```

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m11-m12 -b aic-studio/m11-m12 aic-studio/m10
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m11-m12/aic-studio
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
```

---

## Task 1: Dashboard summary core

**File:** `aic-studio/src/core/dashboard/summary.ts` + test

```typescript
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../db/environments";
import { listOperations } from "../db/opHistory";
import { listAllSnapshotsForEnv } from "../snapshots/paths";

export interface EnvSummary {
  envName: string;
  envLabel: string;
  lastPullAt?: number;
  snapshotCount: number;
  recentOpCount: number;
  hasMonitorAlerts: boolean;
}

export interface DashboardSummary {
  envs: EnvSummary[];
  totalRecentOps: number;
  totalAlerts: number;
}

export function buildDashboardSummary(db: Database, globalStoragePath: string): DashboardSummary {
  const envs = listEnvironments(db);
  const oneWeekAgo = Date.now() - 7 * 86400000;
  const summaries: EnvSummary[] = envs.map((env) => {
    const ops = listOperations(db, env.name, 100);
    const recent = ops.filter((o) => o.startedAt >= oneWeekAgo);
    const lastPull = ops.find((o) => o.opKind === "pull");
    const snapshots = listAllSnapshotsForEnv(globalStoragePath, env.name);
    return {
      envName: env.name,
      envLabel: env.label,
      lastPullAt: lastPull?.startedAt,
      snapshotCount: snapshots.length,
      recentOpCount: recent.length,
      hasMonitorAlerts: false // TODO: query monitor_alerts in M8 integration
    };
  });
  return {
    envs: summaries,
    totalRecentOps: summaries.reduce((a, s) => a + s.recentOpCount, 0),
    totalAlerts: 0
  };
}
```

Tests: empty (no envs) returns empty summary. Seed env + op_history rows; assert correct counts.

(If M8 monitors are present, also query `monitor_alerts`. If not, hasMonitorAlerts stays false. Easier: import only if exists, fall back to 0.)

Commit `feat(aic-studio): dashboard summary aggregation`.

---

## Task 2: Dashboard webview host + UI

**Files:** `webviews/host/dashboardHost.ts`, `webviews/ui/dashboard/{main.tsx,App.tsx,style.css}`

- Host: listens for `RefreshRequest`; calls `buildDashboardSummary`; sends `SummaryResponse`.
- UI: cards for each env (last pull time, snapshot count, op count, alerts pill); top stats row (total ops, total alerts); recent-ops timeline. Uses `@vscode/webview-ui-toolkit`.

Bridge schemas added to `bridge.ts`.

Commit `feat(aic-studio): dashboard webview (summary + recent ops)`.

---

## Task 3: Dashboard command + activation

**File:** `aic-studio/src/commands/dashboard.ts`

- `aic-studio.view.openDashboard` — opens (or focuses) the dashboard webview panel.
- Modify `extension.ts`: at end of activation, read `aic-studio.autoOpenDashboard` config; if true (default), invoke openDashboard command.

Commit `feat(aic-studio): dashboard command + auto-open on activation`.

---

## Task 4: Search index core

**File:** `aic-studio/src/core/search/searchIndex.ts` + test

```typescript
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../db/environments";
import { listActiveTasks } from "../db/promotionTasks";
import { listRealmsInLatest, listJourneysInLatest, listFederationTypesInLatest, listFederationIdsInLatest } from "../snapshots/reader";

export interface SearchItem {
  label: string;
  detail: string;
  kind: "env" | "journey" | "federation" | "promotionTask" | "savedLogQuery";
  uri?: string;
  taskId?: number;
}

export function buildSearchIndex(db: Database, globalStoragePath: string): SearchItem[] {
  const items: SearchItem[] = [];
  for (const env of listEnvironments(db)) {
    items.push({ label: env.label, detail: env.name, kind: "env" });
    for (const realm of listRealmsInLatest(globalStoragePath, env.name)) {
      for (const jid of listJourneysInLatest(globalStoragePath, env.name, realm)) {
        items.push({
          label: jid,
          detail: `${env.name} · ${realm} · journey`,
          kind: "journey",
          uri: `aic://${env.name}/${realm}/journey/${jid}`
        });
      }
      for (const type of listFederationTypesInLatest(globalStoragePath, env.name, realm)) {
        for (const fid of listFederationIdsInLatest(globalStoragePath, env.name, realm, type)) {
          items.push({
            label: fid,
            detail: `${env.name} · ${realm} · ${type}`,
            kind: "federation",
            uri: `aic://${env.name}/${realm}/federation/${type}/${fid}`
          });
        }
      }
    }
  }
  for (const t of listActiveTasks(db)) {
    items.push({
      label: t.name,
      detail: `promotion task · from ${t.sourceEnv}`,
      kind: "promotionTask",
      taskId: t.id
    });
  }
  return items;
}

export function queryIndex(index: SearchItem[], q: string): SearchItem[] {
  const norm = q.toLowerCase();
  return index.filter((i) =>
    i.label.toLowerCase().includes(norm) ||
    i.detail.toLowerCase().includes(norm)
  );
}
```

Tests: seed temp DB + snapshot fixtures; build index; query for known strings; assert hits.

Commit `feat(aic-studio): search index builder + query`.

---

## Task 5: Search command (QuickPick)

**File:** `aic-studio/src/commands/search.ts`

```typescript
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { buildSearchIndex, queryIndex, type SearchItem } from "../core/search/searchIndex";

export function registerSearchCommands(ctx: vscode.ExtensionContext, deps: {
  db: Database;
  globalStoragePath: string;
}): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.search.configs", async () => {
      const index = buildSearchIndex(deps.db, deps.globalStoragePath);
      const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { item: SearchItem }>();
      qp.placeholder = "Search envs / journeys / federation / promotion tasks…";
      qp.items = index.map((i) => ({ label: i.label, description: i.detail, item: i }));
      qp.onDidChangeValue((q) => {
        const filtered = queryIndex(index, q);
        qp.items = filtered.map((i) => ({ label: i.label, description: i.detail, item: i }));
      });
      qp.onDidAccept(() => {
        const picked = qp.selectedItems[0];
        if (picked) {
          if (picked.item.uri) {
            void vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(picked.item.uri));
          }
        }
        qp.hide();
      });
      qp.show();
    })
  );
}
```

Commit `feat(aic-studio): aic-studio.search.configs QuickPick command`.

---

## Task 6: Wire dashboard + search into extension.ts

Register dashboard + search commands; auto-open dashboard if config enabled.

Commit.

---

## Task 7: package.json contributes

Add commands `aic-studio.view.openDashboard`, `aic-studio.search.configs`. Add keybinding for search: `cmd+shift+f` when `viewContainerId == aic-studio` (override-free in default keymap).

Commit.

---

## Task 8: Integration tests

```typescript
// tests/integration/suite/dashboard.test.ts
suite("Dashboard", () => {
  test("view.openDashboard is registered", …);
  test("view.openDashboard does not reject when invoked", …);
});

// tests/integration/suite/search.test.ts
suite("Search", () => {
  test("search.configs is registered", …);
});
```

Add to esbuild. Run. Commit.

---

## Task 9: CHANGELOG + acceptance gate

CHANGELOG above M10 section. Acceptance gate same shape as M3.

---

## Self-Review

**Spec coverage:** §2 Dashboard webview ✓, Search QuickPick ✓. §4 commands ✓. §6 tests ✓.

**Type consistency:** `DashboardSummary{envs, totalRecentOps, totalAlerts}` matches webview UI expectations. `SearchItem.kind` enum exhaustive.

**Notes:**
- Dashboard auto-open is conditional on config — must check the setting first.
- Search index rebuilds on every invocation (cheap for ≤1000 items). For larger orgs, cache + invalidate on pull events.
- If M8 (monitors) hasn't shipped, `hasMonitorAlerts` stays false. Document this in CHANGELOG.
- Keybinding may collide with VS Code's built-in `cmd+shift+f` (Find in Files) — use a `when` clause restricting to AIC Studio context, OR drop the keybinding and rely on palette.

Plan ready.
