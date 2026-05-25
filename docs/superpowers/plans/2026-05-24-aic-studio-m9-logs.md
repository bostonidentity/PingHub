# AIC Studio M9 — Logs Query Webview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the AIC tenant log query feature. AIC exposes a Logs API at `https://<tenant>/monitoring/logs?source=<source>&_pageSize=N&_queryFilter=…` with separate API key + secret per env (not OAuth). M9 adds:
- Per-env log API credential storage (separate from OAuth `client-secret`; uses existing `SecretStorage` slots `log-api-key` + `log-api-secret` from M1)
- Log query webview: source picker, time range, filter expression, result table
- Logs sidebar TreeView shows saved log queries

**Architecture:** Adds `src/core/aic/logs.ts` (queryLogs against monitoring/logs endpoint with api-key + secret headers, NOT bearer auth). Webview (React + @vscode/webview-ui-toolkit) for query UI. Logs TreeView for saved queries persisted in SQLite (`saved_log_queries` table, schema v6). No paging in M9 — just first N results.

**Branch:** `aic-studio/m9` branched from `aic-studio/m8`.

---

## File Structure

```
aic-studio/
  src/
    core/
      db/
        schema.ts                                MODIFY — migration v6 (saved_log_queries)
        savedLogQueries.ts                       NEW — CRUD
        savedLogQueries.test.ts                  NEW
      aic/
        logs.ts                                  NEW — queryLogs (api-key auth)
        logs.test.ts                             NEW (nock)
        urls.ts                                  MODIFY — add logsQueryUrl
        urls.test.ts                             MODIFY
    providers/
      logsTree.ts                                NEW — replace M1 placeholder
    commands/
      logs.ts                                    NEW — open log query webview
    webviews/host/
      logsQueryHost.ts                           NEW
    webviews/ui/logs-query/
      main.tsx                                   NEW
      App.tsx                                    NEW — search + results table
      style.css                                  NEW
    extension.ts                                 MODIFY — wire logs
  package.json                                   MODIFY — add commands + config
  esbuild.config.mjs                             MODIFY — add logs webview bundle
  tests/integration/suite/
    logs.test.ts                                 NEW
```

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m9 -b aic-studio/m9 aic-studio/m8
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m9/aic-studio
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
```

---

## Task 1: Schema v6 (saved_log_queries)

Modify `schema.ts`. SCHEMA_VERSION=6. Migration v6:

```typescript
  ,{
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS saved_log_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env_name TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        filter_expr TEXT,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_saved_log_queries_env ON saved_log_queries(env_name, name);
    `
  }
```

Verify typecheck + connection.test. Commit.

---

## Task 2: saved_log_queries CRUD

**File:** `aic-studio/src/core/db/savedLogQueries.ts` + test

Functions: `saveQuery(db, {envName, name, source, filterExpr})`, `listSavedQueries(db, envName)`, `getSavedQuery(db, id)`, `updateLastRun(db, id)`, `deleteSavedQuery(db, id)`. Standard tests.

Commit.

---

## Task 3: AIC logs URL builder

Modify `aic-studio/src/core/aic/urls.ts` + test. Add:

```typescript
export function logsQueryUrl(tenantUrl: string, params: {
  source: string;
  filterExpr?: string;
  pageSize?: number;
  beginTime?: string;
  endTime?: string;
}): string {
  const q = new URLSearchParams({ source: params.source });
  q.set("_pageSize", String(params.pageSize ?? 100));
  if (params.filterExpr) q.set("_queryFilter", params.filterExpr);
  if (params.beginTime) q.set("beginTime", params.beginTime);
  if (params.endTime) q.set("endTime", params.endTime);
  return `${trimSlash(tenantUrl)}/monitoring/logs?${q.toString()}`;
}
```

Tests for URL composition with various param combinations.

Commit.

---

## Task 4: queryLogs (api-key auth)

**File:** `aic-studio/src/core/aic/logs.ts` + test

Logs API uses different auth than AM — direct `x-api-key` + `x-api-secret` headers, no OAuth token.

```typescript
import axios from "axios";
import { logsQueryUrl } from "./urls";

export interface LogQueryParams {
  tenantUrl: string;
  apiKey: string;
  apiSecret: string;
  source: string;
  filterExpr?: string;
  pageSize?: number;
  beginTime?: string;
  endTime?: string;
}

export interface LogEntry {
  timestamp: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface LogQueryResult {
  entries: LogEntry[];
  pagedResultsCookie?: string;
}

export async function queryLogs(params: LogQueryParams): Promise<LogQueryResult> {
  const url = logsQueryUrl(params.tenantUrl, {
    source: params.source,
    filterExpr: params.filterExpr,
    pageSize: params.pageSize,
    beginTime: params.beginTime,
    endTime: params.endTime
  });
  try {
    const res = await axios.get<{
      result: Array<{ timestamp: string; source: string; type: string; payload: Record<string, unknown> }>;
      pagedResultsCookie?: string;
    }>(url, {
      headers: {
        "x-api-key": params.apiKey,
        "x-api-secret": params.apiSecret,
        Accept: "application/json"
      }
    });
    return {
      entries: res.data.result.map((r) => ({
        timestamp: r.timestamp,
        source: r.source,
        type: r.type,
        payload: r.payload
      })),
      pagedResultsCookie: res.data.pagedResultsCookie
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      throw new Error(`AIC logs query → ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}
```

Tests with nock — verify x-api-key + x-api-secret headers sent, return shape parsed correctly, error handling on 4xx/5xx.

Commit.

---

## Task 5: LogsTreeProvider

**File:** `aic-studio/src/providers/logsTree.ts`

Replaces M1 placeholder. Shows per-env nodes; each env expands to its saved queries. Right-click context menu actions: run, edit, delete.

Commit.

---

## Task 6: Logs commands

**File:** `aic-studio/src/commands/logs.ts`

- `aic-studio.logs.openQueryEditor` — opens webview (new query or load saved)
- `aic-studio.logs.runSavedQuery` — runs a saved query and shows results in webview
- `aic-studio.logs.deleteSavedQuery` — confirms then deletes

Each command reads env's log-api-key and log-api-secret from SecretStorage. If missing, prompts user to set via QuickPick → InputBox flow.

Commit.

---

## Task 7-10: Logs query webview

- **Task 7:** esbuild config + react deps (skip if M7 already installed)
- **Task 8:** Bridge schemas (Zod) for: `OpenRequest`, `RunQueryRequest{source, filterExpr, beginTime, endTime}`, `RunQueryResponse{entries}`, `SaveQueryRequest`
- **Task 9:** Webview host (`webviews/host/logsQueryHost.ts`) — handles messages, calls `queryLogs` core, returns results
- **Task 10:** React UI (`webviews/ui/logs-query/{main.tsx,App.tsx,style.css}`) — source picker, datetime range, filter input, results virtual table, save/run buttons

Each task follows M1-M3 patterns. If specifics drift from the plan, escalate.

---

## Task 11: Wire logs into extension.ts

Register LogsTreeProvider, log commands. Commit.

---

## Task 12: package.json contributes

Add 3 new commands + per-env-context menu entries.

Commit.

---

## Task 13: Integration test — logs command surface

```typescript
suite("Logs commands", () => {
  test("logs.openQueryEditor registered", …);
  test("logs.runSavedQuery registered", …);
  test("logs.deleteSavedQuery registered", …);
});
```

Add to esbuild. Run. Commit.

---

## Task 14: CHANGELOG + acceptance gate

CHANGELOG above M8 section. Acceptance gate same shape as M3.

---

## Self-Review

**Spec coverage:** §2 Logs as webview ✓. §3 saved_log_queries table ✓. §4 logs commands ✓.

**Type consistency:** `LogQueryResult{entries, pagedResultsCookie}` shape matches across core + webview bridge + UI.

**Notes:**
- Log API uses `x-api-key`/`x-api-secret` NOT bearer — different auth path entirely.
- AIC's Logs API has rate limits; webview should debounce search inputs and show "loading" state.
- Source picker should have presets: `am-everything`, `am-authentication`, `am-access`, `idm-everything`, etc. (See `aic-pipeline/src/lib/log-query.ts` for the canonical list to port.)
- No paging in M9 — page size capped at 1000. Pagination is M9.1.

Plan ready.
