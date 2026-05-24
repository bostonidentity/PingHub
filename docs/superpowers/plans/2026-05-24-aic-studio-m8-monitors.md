# AIC Studio M8 — Monitors View + Dashboard Webview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Periodically check the health of each AIC environment and surface results in the Monitors sidebar view + a rich dashboard webview. Specifically:
- **TLS certificate expiration** for each env's tenant URL (`tls-monitors` from legacy app)
- **Server reachability + auth** (basic OAuth token fetch round-trip)
- **RCS status** (Remote Connector Server — `/openidm/system?_action=test` on IDM side)
- Background polling on a configurable interval; surface warnings in status bar
- Monitor Dashboard webview shows charts (cert days-remaining bar chart, ping history line chart) using `recharts`

**Architecture:** Three modules under `src/core/monitors/`: `tls.ts`, `serverPing.ts`, `rcs.ts`. Polling driven by a single `MonitorScheduler` running setInterval. Results stored in two SQLite tables (`monitor_checks` + `monitor_alerts`, schema migration v5). Sidebar TreeView shows latest status per env+check-type. Dashboard webview (React + recharts) opened via command.

**Tech Stack:** Adds `recharts` (already in original aic-pipeline), `tls` (Node built-in for cert inspection). React + @vscode/webview-ui-toolkit (already installed if M7 ran first; otherwise this plan installs them).

**Branch:** `aic-studio/m8` branched from `aic-studio/m7` (or M3 if M7 not yet done; some pieces may be redundant).

---

## File Structure

```
aic-studio/
  src/
    core/
      db/
        schema.ts                                MODIFY — migration v5 (monitor_checks, monitor_alerts)
        monitorChecks.ts                         NEW — CRUD for check results
        monitorChecks.test.ts                    NEW
      monitors/
        tls.ts                                   NEW — fetch cert; days to expiry
        tls.test.ts                              NEW (mocked tls.connect)
        serverPing.ts                            NEW — auth-roundtrip check
        serverPing.test.ts                       NEW (nock)
        rcs.ts                                   NEW — RCS status via IDM REST
        rcs.test.ts                              NEW (nock)
        scheduler.ts                             NEW — setInterval-based polling
        scheduler.test.ts                        NEW
    providers/
      monitorsTree.ts                            NEW — replace M1 placeholder
    commands/
      monitor.ts                                 NEW — open dashboard + poll-now
    status/
      monitorAlertStatusBar.ts                   NEW — warning indicator
    webviews/host/
      monitorDashboardHost.ts                    NEW
    webviews/ui/monitor-dashboard/
      main.tsx                                   NEW
      App.tsx                                    NEW — charts via recharts
      style.css                                  NEW
    extension.ts                                 MODIFY — wire monitor system
  package.json                                   MODIFY — add commands + recharts dep
  esbuild.config.mjs                             MODIFY — add monitor dashboard webview bundle
  tests/integration/suite/
    monitors.test.ts                             NEW
```

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m8 -b aic-studio/m8 aic-studio/m7
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m8/aic-studio
npm install recharts@^3.8.1
# If M7 didn't install react/@vscode/webview-ui-toolkit, install them here.
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
```

---

## Task 1: Schema migration v5 (monitor tables)

Modify `aic-studio/src/core/db/schema.ts`. Bump to SCHEMA_VERSION=5. Append migration:

```typescript
  ,{
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS monitor_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env_name TEXT NOT NULL,
        check_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        checked_at INTEGER NOT NULL,
        days_remaining INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_monitor_env_type ON monitor_checks(env_name, check_type, checked_at DESC);

      CREATE TABLE IF NOT EXISTS monitor_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env_name TEXT NOT NULL,
        check_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );
    `
  }
```

Verify typecheck + connection.test idempotency. Commit `feat(aic-studio): monitor_checks + monitor_alerts schema (migration v5)`.

---

## Task 2: monitor_checks CRUD

**File:** `aic-studio/src/core/db/monitorChecks.ts` + test

Functions: `recordCheck(db, input)`, `latestCheck(db, envName, checkType)`, `listChecks(db, envName, checkType, limit)`, `recordAlert(db, input)`, `acknowledgeAlert(db, id)`, `listActiveAlerts(db, envName)`.

Tests: insert + retrieve, latest-only-returns-most-recent, alert lifecycle (record → list → ack → not-listed).

Commit `feat(aic-studio): monitor checks + alerts CRUD`.

---

## Task 3: TLS cert inspection

**File:** `aic-studio/src/core/monitors/tls.ts` + test

Use Node's built-in `tls.connect`:

```typescript
import { connect } from "node:tls";

export interface TlsCheckResult {
  ok: boolean;
  daysRemaining: number;
  subject: string;
  issuer: string;
  validTo: Date;
  error?: string;
}

export function checkTls(host: string, port = 443, timeoutMs = 5000): Promise<TlsCheckResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const validTo = new Date(cert.valid_to);
      const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86400000);
      resolve({
        ok: true,
        daysRemaining,
        subject: cert.subject?.CN ?? "",
        issuer: cert.issuer?.CN ?? "",
        validTo
      });
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve({ ok: false, daysRemaining: 0, subject: "", issuer: "", validTo: new Date(0), error: "timeout" });
    });
    socket.on("error", (err) => resolve({ ok: false, daysRemaining: 0, subject: "", issuer: "", validTo: new Date(0), error: err.message }));
  });
}
```

Tests: connect to a known good host (e.g. `example.com`) and assert daysRemaining > 0. Connect to invalid host → ok=false. Use vitest skip-if-offline pattern.

Commit `feat(aic-studio): TLS certificate inspection`.

---

## Task 4: Server ping check

**File:** `aic-studio/src/core/monitors/serverPing.ts` + test

Roundtrips an OAuth token fetch against the tenant — if it succeeds, server is reachable + creds work. Reuses `fetchAccessToken` from `src/core/aic/auth.ts`. Returns `{ ok, latencyMs, error? }`. Tests use nock to mock 200, 401, network error responses.

Commit `feat(aic-studio): server ping check (OAuth roundtrip)`.

---

## Task 5: RCS status check

**File:** `aic-studio/src/core/monitors/rcs.ts` + test

Calls `<tenant>/openidm/system?_action=test` with bearer auth. Returns RCS connector status per connector. Tests mock with nock.

Commit `feat(aic-studio): RCS status check`.

---

## Task 6: MonitorScheduler

**File:** `aic-studio/src/core/monitors/scheduler.ts` + test

```typescript
export interface SchedulerDeps {
  intervalMs: number;
  runOnce: () => Promise<void>;
}

export class MonitorScheduler {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly deps: SchedulerDeps) {}
  start(): void {
    if (this.timer) return;
    void this.deps.runOnce();
    this.timer = setInterval(() => { void this.deps.runOnce(); }, this.deps.intervalMs);
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
```

Tests: start triggers immediate runOnce + setInterval. Stop clears interval. Multiple starts are idempotent.

Commit `feat(aic-studio): MonitorScheduler (setInterval polling)`.

---

## Task 7: MonitorsTreeProvider

**File:** `aic-studio/src/providers/monitorsTree.ts`

Replaces M1 placeholder. Shows per-env nodes; each env node expands to per-check-type latest-status (TLS, Server, RCS) with severity-colored icons (pass/warning/error). Click on a check item shows latest detail via Quickpick or opens a virtual document.

Commit `feat(aic-studio): MonitorsTreeProvider (replaces placeholder)`.

---

## Task 8: Monitor commands + status bar

**File:** `aic-studio/src/commands/monitor.ts`, `src/status/monitorAlertStatusBar.ts`

Commands: `aic-studio.monitor.pollNow` (forces immediate check), `aic-studio.monitor.openDashboard` (opens webview), `aic-studio.monitor.acknowledgeAlert`.

Status bar item showing `$(warning) N monitor alerts` when active alerts exist; click → reveals Monitors view.

Commit `feat(aic-studio): monitor commands + alert status bar item`.

---

## Task 9: Monitor dashboard webview

**Files:** `webviews/host/monitorDashboardHost.ts`, `webviews/ui/monitor-dashboard/main.tsx`, `App.tsx`, `style.css`

React app loads check history via postMessage, renders:
- Bar chart: per-env TLS days-remaining (recharts)
- Line chart: ping latency over time per env
- Alerts table with ack action

Uses `@vscode/webview-ui-toolkit` for tables/buttons; recharts for charts.

esbuild config gets new entry point for the bundle output.

Commit `feat(aic-studio): monitor dashboard webview (recharts)`.

---

## Task 10: Wire into extension.ts

Register MonitorsTreeProvider, instantiate MonitorScheduler in activation, start polling, register commands. Threshold for TLS warning configurable via `aic-studio.monitor.tlsThresholdDays` (default 30) — read from VS Code config.

Commit `feat(aic-studio): wire monitor system into activation`.

---

## Task 11: package.json contributes

Add new commands; add `aic-studio.monitor.tlsThresholdDays` and `aic-studio.monitor.pollIntervalMinutes` to `contributes.configuration`.

Commit `feat(aic-studio): contribute monitor commands + config`.

---

## Task 12: Integration test — monitor command surface

```typescript
suite("Monitor commands", () => {
  test("monitor.pollNow registered", async () => { … });
  test("monitor.openDashboard registered", async () => { … });
  test("monitor.acknowledgeAlert registered", async () => { … });
});
```

Add to esbuild. Run integration tests.

Commit `test(aic-studio): monitor integration tests`.

---

## Task 13: CHANGELOG + acceptance gate

CHANGELOG above M7 section. Acceptance gate same shape as M3.

---

## Self-Review

**Spec coverage:** §2 Monitor as tree + webview ✓. §3 monitor tables ✓. §4 monitor commands ✓. §6 tests ✓.

**Type consistency:** `TlsCheckResult` / `PingCheckResult` / `RcsCheckResult` consistent shape `{ ok, …, error? }`. `MonitorCheckRow` matches monitorChecks.ts schema. Scheduler decoupled from VS Code.

**Notes on scope:**
- Tests for `tls.ts` may need to skip when offline. Use `vitest.skipIf` or conditional based on a TEST_NETWORK env var.
- Polling defaults to 15 min — don't make it shorter without considering AIC rate limits.
- Dashboard webview is medium effort; if implementation drifts, escalate to controller.

Plan ready.
