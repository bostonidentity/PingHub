# AIC Studio M3 — Push & Promote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension complete the round-trip for journeys. After pulling from a source env (M2), a user can: (a) right-click a journey → "Push to environment…" to send that single journey to another env, OR (b) right-click multiple journeys → "Add to promotion task" to build a saved set, then "Run promotion task" to push them all atomically. SCM panel's Changes group populates by diffing the latest local snapshot against the AIC state at pull-time. Wizard webview is deferred to M3.1.

**Architecture:** Direct REST `PUT /am/json/realms/<realm>/realm-config/authentication/authenticationtrees/<id>` for journey push (mirrors M2's GET pattern). One new SQLite table `promotion_tasks` (schema v3). Two new commands: `aic-studio.sync.push` and `aic-studio.promote.*`. Promotion Tasks sidebar view becomes functional. Each push records a `op_history` row.

**Tech Stack:** Same as M2 (axios, better-sqlite3, vscode, vitest, nock). No new runtime deps.

**Spec:** [`docs/superpowers/specs/2026-05-24-aic-studio-vscode-extension-design.md`](../specs/2026-05-24-aic-studio-vscode-extension-design.md)
**Prior plans:** [M1](./2026-05-24-aic-studio-m1-scaffold-and-environments.md) · [M2](./2026-05-24-aic-studio-m2-pull-and-virtual-docs.md)

**Branch convention:** Build M3 on `aic-studio/m3` branched from `aic-studio/m2`. Pre-task setup at the bottom of this file.

---

## File Structure

New (created in M3):

```
aic-studio/
  src/
    core/
      db/
        schema.ts                              MODIFY — migration v3 (promotion_tasks)
        promotionTasks.ts                      NEW — CRUD
        promotionTasks.test.ts                 NEW — vitest
      aic/
        urls.ts                                MODIFY — no change required; journeyDetailUrl already exists
        client.ts                              MODIFY — add put() method
        client.test.ts                         MODIFY — add PUT tests
        journeys.ts                            MODIFY — add putJourney()
        journeys.test.ts                       MODIFY — add putJourney tests
      push/
        pushJourney.ts                         NEW — single-journey push orchestration
        pushJourney.test.ts                    NEW — vitest (nock)
        pushPromotionTask.ts                   NEW — multi-item push
        pushPromotionTask.test.ts              NEW — vitest (nock)
      diff/
        snapshotDiff.ts                        NEW — local-vs-remote diff for SCM Changes
        snapshotDiff.test.ts                   NEW — vitest
    providers/
      sourceControl.ts                         MODIFY — populate Changes group from snapshot diff
      promotionTasksTree.ts                    NEW — replace placeholder with real tree
    commands/
      push.ts                                  NEW — aic-studio.sync.push command
      promote.ts                               NEW — aic-studio.promote.* commands
    extension.ts                               MODIFY — wire new commands + replace placeholder tree
  package.json                                 MODIFY — add 4 commands + menu entries
  tests/integration/suite/
    pushFlow.test.ts                           NEW — integration test
    promoteFlow.test.ts                        NEW — integration test
```

Two-layer boundary preserved: `core/*` is vscode-free.

---

## Pre-Task Setup

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3 -b aic-studio/m3 aic-studio/m2
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
git -C /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3 branch --show-current   # aic-studio/m3
```

**All git commands** in tasks must be run from inside `.worktrees/aic-studio-m3` (verify cwd before each commit).

---

## Task 1: Schema migration v3 — promotion_tasks

**Files:** Modify `aic-studio/src/core/db/schema.ts`

- [ ] **Step 1: Read schema.ts** — currently has SCHEMA_VERSION=2 and 2 migrations.

- [ ] **Step 2: Bump version to 3 and append migration v3:**

```typescript
  ,{
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS promotion_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source_env TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS promotion_task_items (
        task_id INTEGER NOT NULL,
        realm TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        PRIMARY KEY (task_id, realm, resource_type, resource_id),
        FOREIGN KEY (task_id) REFERENCES promotion_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_promotion_tasks_status ON promotion_tasks(status, updated_at DESC);
    `
  }
```

After edit, MIGRATIONS has 3 entries.

- [ ] **Step 3: typecheck** + **run connection.test.ts** (idempotent migration). Both must pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3
git add aic-studio/src/core/db/schema.ts
git commit -m "feat(aic-studio): add promotion_tasks schema (migration v3)"
```

---

## Task 2: promotion_tasks CRUD

**Files:**
- Create: `aic-studio/src/core/db/promotionTasks.ts`
- Create: `aic-studio/src/core/db/promotionTasks.test.ts`

- [ ] **Step 1: Tests** (Write tool — `promotionTasks.test.ts`):

```typescript
// src/core/db/promotionTasks.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import {
  createPromotionTask,
  addItemToTask,
  removeItemFromTask,
  listItemsInTask,
  listActiveTasks,
  setTaskStatus,
  getTask
} from "./promotionTasks";

let db: Database;
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "ptasks-")); db = openDatabase(join(tmp, "t.db")); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("promotion_tasks", () => {
  it("createPromotionTask inserts with status 'active' and returns id", () => {
    const id = createPromotionTask(db, { name: "release-1", sourceEnv: "prod" });
    expect(typeof id).toBe("number");
    const t = getTask(db, id);
    expect(t?.name).toBe("release-1");
    expect(t?.status).toBe("active");
    expect(t?.sourceEnv).toBe("prod");
  });

  it("addItemToTask is idempotent (PK prevents duplicates)", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    expect(listItemsInTask(db, id)).toHaveLength(1);
  });

  it("removeItemFromTask drops the row", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    removeItemFromTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    expect(listItemsInTask(db, id)).toHaveLength(0);
  });

  it("listActiveTasks returns only 'active' tasks ordered by updated_at DESC", () => {
    const a = createPromotionTask(db, { name: "a", sourceEnv: "prod" });
    const b = createPromotionTask(db, { name: "b", sourceEnv: "prod" });
    setTaskStatus(db, a, "archived");
    const active = listActiveTasks(db);
    expect(active.map((t) => t.id)).toEqual([b]);
  });

  it("setTaskStatus to 'archived' removes from active list", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    expect(listActiveTasks(db)).toHaveLength(1);
    setTaskStatus(db, id, "archived");
    expect(listActiveTasks(db)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementation** (Write tool — `promotionTasks.ts`):

```typescript
// src/core/db/promotionTasks.ts
import type { Database } from "better-sqlite3";

export type TaskStatus = "active" | "archived";

export interface PromotionTaskRow {
  id: number;
  name: string;
  sourceEnv: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskItem {
  realm: string;
  resourceType: string;
  resourceId: string;
}

interface RawTaskRow {
  id: number;
  name: string;
  source_env: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function rowToTask(r: RawTaskRow): PromotionTaskRow {
  return {
    id: r.id,
    name: r.name,
    sourceEnv: r.source_env,
    status: r.status as TaskStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export function createPromotionTask(db: Database, input: { name: string; sourceEnv: string }): number {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO promotion_tasks (name, source_env, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `).run(input.name, input.sourceEnv, now, now);
  return Number(info.lastInsertRowid);
}

export function getTask(db: Database, id: number): PromotionTaskRow | undefined {
  const row = db.prepare("SELECT * FROM promotion_tasks WHERE id = ?").get(id) as RawTaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function listActiveTasks(db: Database): PromotionTaskRow[] {
  const rows = db.prepare(`
    SELECT * FROM promotion_tasks WHERE status = 'active' ORDER BY updated_at DESC
  `).all() as RawTaskRow[];
  return rows.map(rowToTask);
}

export function setTaskStatus(db: Database, id: number, status: TaskStatus): void {
  db.prepare("UPDATE promotion_tasks SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
}

export function addItemToTask(db: Database, taskId: number, item: TaskItem): void {
  db.prepare(`
    INSERT OR IGNORE INTO promotion_task_items (task_id, realm, resource_type, resource_id)
    VALUES (?, ?, ?, ?)
  `).run(taskId, item.realm, item.resourceType, item.resourceId);
  db.prepare("UPDATE promotion_tasks SET updated_at = ? WHERE id = ?").run(Date.now(), taskId);
}

export function removeItemFromTask(db: Database, taskId: number, item: TaskItem): void {
  db.prepare(`
    DELETE FROM promotion_task_items
    WHERE task_id = ? AND realm = ? AND resource_type = ? AND resource_id = ?
  `).run(taskId, item.realm, item.resourceType, item.resourceId);
}

export function listItemsInTask(db: Database, taskId: number): TaskItem[] {
  const rows = db.prepare(`
    SELECT realm, resource_type AS resourceType, resource_id AS resourceId
    FROM promotion_task_items WHERE task_id = ?
    ORDER BY realm, resource_type, resource_id
  `).all(taskId) as TaskItem[];
  return rows;
}
```

- [ ] **Step 4: Run → PASS (5 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/promotionTasks.ts aic-studio/src/core/db/promotionTasks.test.ts
git commit -m "feat(aic-studio): promotion_tasks CRUD"
```

---

## Task 3: Authed HTTP client — add PUT

**Files:**
- Modify: `aic-studio/src/core/aic/client.ts`
- Modify: `aic-studio/src/core/aic/client.test.ts`

- [ ] **Step 1: Append test** (Edit tool — at end of `client.test.ts`):

```typescript

describe("createAuthedClient.put", () => {
  it("PUTs JSON body with Bearer header and returns response", async () => {
    nock("https://prod.id.forgerock.io", {
      reqheaders: {
        authorization: "Bearer test-token",
        "content-type": "application/json"
      }
    })
      .put("/am/json/x", { _id: "x", name: "new" })
      .reply(200, { _id: "x", _rev: "2" });

    const cache = { get: async () => "test-token", invalidate: () => {} };
    const client = createAuthedClient(cache);
    const res = await client.put("https://prod.id.forgerock.io/am/json/x", { _id: "x", name: "new" });
    expect(res.data).toEqual({ _id: "x", _rev: "2" });
  });

  it("PUT retries once after 401", async () => {
    nock("https://prod.id.forgerock.io").put("/am/json/x").reply(401, { error: "expired" });
    nock("https://prod.id.forgerock.io").put("/am/json/x").reply(200, { ok: true });
    let invalidateCalls = 0;
    const cache = { get: async () => "t", invalidate: () => { invalidateCalls += 1; } };
    const client = createAuthedClient(cache);
    const res = await client.put("https://prod.id.forgerock.io/am/json/x", { a: 1 });
    expect(res.data).toEqual({ ok: true });
    expect(invalidateCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL** (client.put doesn't exist)

- [ ] **Step 3: Update implementation** (Edit tool — `client.ts`):

Find the `AuthedClient` interface and extend:

```typescript
export interface AuthedClient {
  get<T = unknown>(url: string): Promise<AxiosResponse<T>>;
  put<T = unknown>(url: string, body: unknown): Promise<AxiosResponse<T>>;
}
```

Then in `createAuthedClient`, refactor the inner `request` to accept a method+body or split into separate get/put helpers. Recommended: parameterize on method, body, and isRetry:

```typescript
export function createAuthedClient(cache: TokenCache): AuthedClient {
  async function request<T>(
    method: "GET" | "PUT",
    url: string,
    body: unknown,
    isRetry: boolean
  ): Promise<AxiosResponse<T>> {
    const token = await cache.get();
    try {
      if (method === "GET") {
        return await axios.get<T>(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
        });
      }
      return await axios.put<T>(url, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401 && !isRetry) {
        cache.invalidate();
        return request<T>(method, url, body, true);
      }
      if (axios.isAxiosError(err) && err.response) {
        throw new Error(`AIC ${method} ${url} → ${err.response.status}`);
      }
      throw err;
    }
  }
  return {
    get: <T>(url: string) => request<T>("GET", url, undefined, false),
    put: <T>(url: string, body: unknown) => request<T>("PUT", url, body, false)
  };
}
```

- [ ] **Step 4: Run → PASS (5 tests in client.test.ts: 3 prior GET + 2 new PUT)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/client.ts aic-studio/src/core/aic/client.test.ts
git commit -m "feat(aic-studio): add PUT to authed HTTP client"
```

---

## Task 4: putJourney

**Files:**
- Modify: `aic-studio/src/core/aic/journeys.ts`
- Modify: `aic-studio/src/core/aic/journeys.test.ts`

- [ ] **Step 1: Append test** at end of `journeys.test.ts`:

```typescript

describe("putJourney", () => {
  it("PUTs the body to the journey detail URL and returns the response body", async () => {
    nock("https://prod.id.forgerock.io")
      .put(/authenticationtrees\/Login$/, { _id: "Login", entryNodeId: "z" })
      .reply(200, { _id: "Login", _rev: "2" });

    const res = await putJourney(
      "https://prod.id.forgerock.io",
      "alpha",
      "Login",
      { _id: "Login", entryNodeId: "z" },
      cache
    );
    expect(res).toEqual({ _id: "Login", _rev: "2" });
  });
});

import { putJourney } from "./journeys";
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Append to `journeys.ts`:**

```typescript

export async function putJourney(
  tenantUrl: string,
  realm: string,
  id: string,
  body: Record<string, unknown>,
  cache: TokenCache
): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.put<Record<string, unknown>>(journeyDetailUrl(tenantUrl, realm, id), body);
  return res.data;
}
```

- [ ] **Step 4: Run → PASS (4 tests: 3 prior + 1 new)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/journeys.ts aic-studio/src/core/aic/journeys.test.ts
git commit -m "feat(aic-studio): putJourney via AM REST"
```

---

## Task 5: Single-journey push core

**Files:**
- Create: `aic-studio/src/core/push/pushJourney.ts`
- Create: `aic-studio/src/core/push/pushJourney.test.ts`

First `mkdir -p aic-studio/src/core/push`

- [ ] **Step 1: Tests** (`pushJourney.test.ts`):

```typescript
// src/core/push/pushJourney.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushJourneyFromSnapshot } from "./pushJourney";

let storage: string;

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "pushj-"));
  nock.disableNetConnect();
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

function seedSnapshot(envName: string, stamp: string, realm: string, id: string, body: unknown) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("pushJourneyFromSnapshot", () => {
  it("reads the journey from the source env's latest snapshot and PUTs to the target", async () => {
    seedSnapshot("prod", "2026-05-24T15-30-00Z", "alpha", "Login", { _id: "Login", entryNodeId: "src" });

    nock("https://stage.id.forgerock.io")
      .put("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Login")
      .reply(200, { _id: "Login", _rev: "5" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const res = await pushJourneyFromSnapshot({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      realm: "alpha",
      journeyId: "Login"
    });
    expect(res.ok).toBe(true);
  });

  it("throws when source snapshot does not contain the journey", async () => {
    const cache = { get: async () => "t", invalidate: () => {} };
    await expect(
      pushJourneyFromSnapshot({
        globalStoragePath: storage,
        sourceEnvName: "prod",
        targetTenantUrl: "https://stage.id.forgerock.io",
        targetTokenCache: cache,
        realm: "alpha",
        journeyId: "Missing"
      })
    ).rejects.toThrow(/no snapshot|not found/i);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementation** (`pushJourney.ts`):

```typescript
// src/core/push/pushJourney.ts
import type { TokenCache } from "../aic/auth";
import { putJourney } from "../aic/journeys";
import { readJourneyFromLatest } from "../snapshots/reader";

export interface PushJourneyParams {
  globalStoragePath: string;
  sourceEnvName: string;
  targetTenantUrl: string;
  targetTokenCache: TokenCache;
  realm: string;
  journeyId: string;
}

export interface PushResult {
  ok: boolean;
  body: Record<string, unknown>;
}

export async function pushJourneyFromSnapshot(params: PushJourneyParams): Promise<PushResult> {
  const body = readJourneyFromLatest(
    params.globalStoragePath,
    params.sourceEnvName,
    params.realm,
    params.journeyId
  );
  if (!body) {
    throw new Error(`no snapshot found for ${params.sourceEnvName}/${params.realm}/${params.journeyId}`);
  }
  const result = await putJourney(
    params.targetTenantUrl,
    params.realm,
    params.journeyId,
    body,
    params.targetTokenCache
  );
  return { ok: true, body: result };
}
```

- [ ] **Step 4: Run → PASS (2 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/push/pushJourney.ts aic-studio/src/core/push/pushJourney.test.ts
git commit -m "feat(aic-studio): pushJourneyFromSnapshot core"
```

---

## Task 6: Multi-item push (promotion task)

**Files:**
- Create: `aic-studio/src/core/push/pushPromotionTask.ts`
- Create: `aic-studio/src/core/push/pushPromotionTask.test.ts`

- [ ] **Step 1: Tests** (`pushPromotionTask.test.ts`):

```typescript
// src/core/push/pushPromotionTask.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushPromotionTask } from "./pushPromotionTask";
import type { TaskItem } from "../db/promotionTasks";

let storage: string;

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "pushpt-"));
  nock.disableNetConnect();
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

function seed(envName: string, stamp: string, realm: string, id: string, body: unknown) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("pushPromotionTask", () => {
  it("pushes every journey item to target env and reports per-item results", async () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", "Login", { _id: "Login" });
    seed("prod", "2026-05-24T15-30-00Z", "alpha", "Register", { _id: "Register" });

    nock("https://stage.id.forgerock.io")
      .put(/authenticationtrees\/Login$/).reply(200, { _id: "Login", _rev: "1" })
      .put(/authenticationtrees\/Register$/).reply(200, { _id: "Register", _rev: "1" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const items: TaskItem[] = [
      { realm: "alpha", resourceType: "journey", resourceId: "Login" },
      { realm: "alpha", resourceType: "journey", resourceId: "Register" }
    ];
    const summary = await pushPromotionTask({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      items
    });
    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(0);
  });

  it("continues on per-item failure and reports them all", async () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", "Login", { _id: "Login" });

    nock("https://stage.id.forgerock.io")
      .put(/authenticationtrees\/Login$/).reply(500, { error: "boom" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const items: TaskItem[] = [
      { realm: "alpha", resourceType: "journey", resourceId: "Login" }
    ];
    const summary = await pushPromotionTask({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      items
    });
    expect(summary.successCount).toBe(0);
    expect(summary.failureCount).toBe(1);
    expect(summary.failures[0].error).toMatch(/500/);
  });

  it("skips non-journey resource types in M3 (returns them as 'skipped')", async () => {
    const cache = { get: async () => "t", invalidate: () => {} };
    const items: TaskItem[] = [
      { realm: "alpha", resourceType: "script", resourceId: "S1" }
    ];
    const summary = await pushPromotionTask({
      globalStoragePath: storage,
      sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io",
      targetTokenCache: cache,
      items
    });
    expect(summary.skippedCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementation** (`pushPromotionTask.ts`):

```typescript
// src/core/push/pushPromotionTask.ts
import type { TokenCache } from "../aic/auth";
import type { TaskItem } from "../db/promotionTasks";
import { pushJourneyFromSnapshot } from "./pushJourney";

export interface PushTaskParams {
  globalStoragePath: string;
  sourceEnvName: string;
  targetTenantUrl: string;
  targetTokenCache: TokenCache;
  items: TaskItem[];
}

export interface ItemFailure {
  item: TaskItem;
  error: string;
}

export interface PushTaskSummary {
  successCount: number;
  failureCount: number;
  skippedCount: number;
  failures: ItemFailure[];
}

export async function pushPromotionTask(params: PushTaskParams): Promise<PushTaskSummary> {
  let successCount = 0;
  let skippedCount = 0;
  const failures: ItemFailure[] = [];

  for (const item of params.items) {
    if (item.resourceType !== "journey") {
      skippedCount += 1;
      continue;
    }
    try {
      await pushJourneyFromSnapshot({
        globalStoragePath: params.globalStoragePath,
        sourceEnvName: params.sourceEnvName,
        targetTenantUrl: params.targetTenantUrl,
        targetTokenCache: params.targetTokenCache,
        realm: item.realm,
        journeyId: item.resourceId
      });
      successCount += 1;
    } catch (err) {
      failures.push({
        item,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { successCount, failureCount: failures.length, skippedCount, failures };
}
```

- [ ] **Step 4: Run → PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/push/pushPromotionTask.ts aic-studio/src/core/push/pushPromotionTask.test.ts
git commit -m "feat(aic-studio): pushPromotionTask (multi-item push with continue-on-failure)"
```

---

## Task 7: Snapshot diff helper

**Files:**
- Create: `aic-studio/src/core/diff/snapshotDiff.ts`
- Create: `aic-studio/src/core/diff/snapshotDiff.test.ts`

First `mkdir -p aic-studio/src/core/diff`

- [ ] **Step 1: Tests** (`snapshotDiff.test.ts`):

```typescript
// src/core/diff/snapshotDiff.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLocallyModifiedJourneys } from "./snapshotDiff";

let storage: string;
beforeEach(() => { storage = mkdtempSync(join(tmpdir(), "diff-")); });
afterEach(() => { rmSync(storage, { recursive: true, force: true }); });

function seed(envName: string, stamp: string, realm: string, id: string, body: unknown) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("findLocallyModifiedJourneys", () => {
  it("returns [] when there's only one snapshot", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login", v: 1 });
    expect(findLocallyModifiedJourneys(storage, "prod")).toEqual([]);
  });

  it("returns items where the latest snapshot differs from the previous one", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login", v: 1 });
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Register", { _id: "Register", v: 1 });
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "Login", { _id: "Login", v: 2 });   // changed
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "Register", { _id: "Register", v: 1 }); // same
    const diffs = findLocallyModifiedJourneys(storage, "prod");
    expect(diffs).toEqual([{ realm: "alpha", resourceType: "journey", resourceId: "Login" }]);
  });

  it("treats items present in latest but not in prior as modified", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login", v: 1 });
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "Login", { _id: "Login", v: 1 });
    seed("prod", "2026-05-24T12-00-00Z", "alpha", "NewOne", { _id: "NewOne" });
    const diffs = findLocallyModifiedJourneys(storage, "prod");
    expect(diffs).toContainEqual({ realm: "alpha", resourceType: "journey", resourceId: "NewOne" });
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementation** (`snapshotDiff.ts`):

```typescript
// src/core/diff/snapshotDiff.ts
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envSnapshotDir } from "../snapshots/paths";

export interface ChangedItem {
  realm: string;
  resourceType: string;
  resourceId: string;
}

function listSnapshotDirsByMtime(globalStoragePath: string, envName: string): string[] {
  const root = envSnapshotDir(globalStoragePath, envName);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, m: statSync(join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((e) => join(root, e.name));
}

function collectJourneys(snapDir: string): Map<string, string> {
  // key = `${realm}/${id}`, value = JSON stringified
  const out = new Map<string, string>();
  if (!existsSync(snapDir)) return out;
  for (const realm of readdirSync(snapDir, { withFileTypes: true })) {
    if (!realm.isDirectory()) continue;
    const jdir = join(snapDir, realm.name, "journeys");
    if (!existsSync(jdir)) continue;
    for (const f of readdirSync(jdir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const id = f.name.replace(/\.json$/, "");
      out.set(`${realm.name}/${id}`, readFileSync(join(jdir, f.name), "utf8"));
    }
  }
  return out;
}

export function findLocallyModifiedJourneys(globalStoragePath: string, envName: string): ChangedItem[] {
  const dirs = listSnapshotDirsByMtime(globalStoragePath, envName);
  if (dirs.length < 2) return [];
  const latest = collectJourneys(dirs[0]);
  const prior = collectJourneys(dirs[1]);
  const changes: ChangedItem[] = [];
  for (const [key, body] of latest.entries()) {
    if (prior.get(key) !== body) {
      const [realm, id] = key.split("/");
      changes.push({ realm, resourceType: "journey", resourceId: id });
    }
  }
  return changes;
}
```

- [ ] **Step 4: Run → PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/diff/snapshotDiff.ts aic-studio/src/core/diff/snapshotDiff.test.ts
git commit -m "feat(aic-studio): snapshot diff (locally-modified journeys)"
```

---

## Task 8: Promotion Tasks tree provider

**Files:**
- Create: `aic-studio/src/providers/promotionTasksTree.ts`

- [ ] **Step 1: Implementation** (Write tool):

```typescript
// src/providers/promotionTasksTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  listActiveTasks,
  listItemsInTask,
  type PromotionTaskRow,
  type TaskItem
} from "../core/db/promotionTasks";

type Node = TaskNode | ItemNode;

export class TaskNode extends vscode.TreeItem {
  constructor(public readonly task: PromotionTaskRow) {
    super(task.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `promotion-task:${task.id}`;
    this.contextValue = "aic-studio.promotionTask";
    this.description = `from ${task.sourceEnv}`;
    this.iconPath = new vscode.ThemeIcon("rocket");
  }
}

export class ItemNode extends vscode.TreeItem {
  constructor(public readonly taskId: number, public readonly item: TaskItem) {
    super(`${item.realm} / ${item.resourceType} / ${item.resourceId}`, vscode.TreeItemCollapsibleState.None);
    this.id = `promotion-task-item:${taskId}:${item.realm}:${item.resourceType}:${item.resourceId}`;
    this.contextValue = "aic-studio.promotionTaskItem";
    this.iconPath = new vscode.ThemeIcon("file-code");
  }
}

export class PromotionTasksTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly db: Database) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return listActiveTasks(this.db).map((t) => new TaskNode(t));
    }
    if (element instanceof TaskNode) {
      return listItemsInTask(this.db, element.task.id).map((i) => new ItemNode(element.task.id, i));
    }
    return [];
  }
}
```

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/providers/promotionTasksTree.ts
git commit -m "feat(aic-studio): PromotionTasksTreeProvider (replaces placeholder)"
```

---

## Task 9: SCM Changes population

**Files:**
- Modify: `aic-studio/src/providers/sourceControl.ts`

- [ ] **Step 1: Read current sourceControl.ts** — currently creates empty Changes group per env.

- [ ] **Step 2: Rewrite (Write tool, overwriting) to populate Changes from snapshot diff:**

```typescript
// src/providers/sourceControl.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { findLocallyModifiedJourneys, type ChangedItem } from "../core/diff/snapshotDiff";
import { makeAicUri } from "./virtualDocs";

interface EnvScm {
  scm: vscode.SourceControl;
  changes: vscode.SourceControlResourceGroup;
}

export class EnvSourceControlRegistry {
  private readonly scms = new Map<string, EnvScm>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly db: Database,
    private readonly globalStoragePath: string
  ) {}

  syncFromDb(): void {
    const envs = listEnvironments(this.db);
    const envNames = new Set(envs.map((e) => e.name));

    for (const [name, entry] of this.scms.entries()) {
      if (!envNames.has(name)) {
        entry.scm.dispose();
        this.scms.delete(name);
      }
    }

    for (const env of envs) {
      if (!this.scms.has(env.name)) {
        const scm = vscode.scm.createSourceControl(
          `aic-env-${env.name}`,
          `AIC: ${env.label}`,
          vscode.Uri.parse(`aic://${env.name}`)
        );
        scm.acceptInputCommand = {
          command: "aic-studio.sync.push",
          title: "Push to env"
        };
        const changes = scm.createResourceGroup("changes", "Changes");
        this.ctx.subscriptions.push(scm);
        this.scms.set(env.name, { scm, changes });
      }
    }

    this.refreshChanges();
  }

  /** Recompute Changes group resources for every env. */
  refreshChanges(): void {
    for (const [envName, entry] of this.scms.entries()) {
      const diffs: ChangedItem[] = findLocallyModifiedJourneys(this.globalStoragePath, envName);
      entry.changes.resourceStates = diffs.map((d) => ({
        resourceUri: makeAicUri(envName, d.realm, d.resourceType, d.resourceId),
        decorations: { strikeThrough: false }
      }));
      entry.scm.count = diffs.length;
    }
  }
}
```

- [ ] **Step 3: Update `extension.ts`** — the `EnvSourceControlRegistry` constructor now takes a 3rd arg `globalStoragePath`. Find:

```typescript
const scmRegistry = new EnvSourceControlRegistry(ctx, db);
```

And change to:

```typescript
const scmRegistry = new EnvSourceControlRegistry(ctx, db, ctx.globalStorageUri.fsPath);
```

- [ ] **Step 4: typecheck + integration tests** must still pass (no behavior change to existing tests; just resourceStates is now populated)

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio
npm run typecheck
npm run test:integration
```

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/providers/sourceControl.ts aic-studio/src/extension.ts
git commit -m "feat(aic-studio): populate SCM Changes from snapshot diff"
```

---

## Task 10: Push command (single journey)

**Files:**
- Create: `aic-studio/src/commands/push.ts`

- [ ] **Step 1: Implementation** (Write tool):

```typescript
// src/commands/push.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  getEnvironmentByName,
  listEnvironments
} from "../core/db/environments";
import type { SecretStore } from "../core/env/secrets";
import { createTokenCache, fetchAccessToken } from "../core/aic/auth";
import { pushJourneyFromSnapshot } from "../core/push/pushJourney";
import { startOperation, finishOperation } from "../core/db/opHistory";
import type { JourneyNode } from "../providers/envTree";
import { log, logError } from "../logging/output";

type Deps = {
  db: Database;
  secrets: SecretStore;
  globalStoragePath: string;
  onChange: () => void;
};

export function registerPushCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.sync.push", (node?: JourneyNode) =>
      pushCommand(deps, node)
    )
  );
}

async function pushCommand(deps: Deps, node?: JourneyNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage(
      "Right-click a journey in the Environments tree, then 'Push to environment…'."
    );
    return;
  }
  const others = listEnvironments(deps.db).filter((e) => e.name !== node.envName);
  if (others.length === 0) {
    void vscode.window.showInformationMessage("No other environment to push to.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    others.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: `Push ${node.realm}/${node.journeyId} from ${node.envName} to…` }
  );
  if (!pick) return;

  const targetEnv = getEnvironmentByName(deps.db, pick.name);
  if (!targetEnv) return;
  const clientSecret = await deps.secrets.get(pick.name, "client-secret");
  if (!clientSecret) {
    void vscode.window.showErrorMessage(
      `No client secret configured for "${pick.name}".`
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Push ${node.realm}/${node.journeyId} → "${targetEnv.label}"?`,
    { modal: true },
    "Push"
  );
  if (confirm !== "Push") return;

  const opId = startOperation(deps.db, {
    envName: pick.name,
    opKind: "push",
    scope: `journey:${node.realm}/${node.journeyId}`
  });
  log(`push start: ${node.envName} → ${pick.name} ${node.realm}/${node.journeyId}`);

  try {
    const tokenCache = createTokenCache(() =>
      fetchAccessToken({
        tenantUrl: targetEnv.tenantUrl,
        clientId: targetEnv.clientId,
        clientSecret
      })
    );
    await pushJourneyFromSnapshot({
      globalStoragePath: deps.globalStoragePath,
      sourceEnvName: node.envName,
      targetTenantUrl: targetEnv.tenantUrl,
      targetTokenCache: tokenCache,
      realm: node.realm,
      journeyId: node.journeyId
    });
    finishOperation(deps.db, opId, "success", `pushed ${node.realm}/${node.journeyId}`);
    log(`push success: ${pick.name} ${node.realm}/${node.journeyId}`);
    void vscode.window.showInformationMessage(
      `Pushed ${node.realm}/${node.journeyId} to "${targetEnv.label}"`
    );
    deps.onChange();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishOperation(deps.db, opId, "failure", msg);
    logError(`push failed`, err);
    void vscode.window.showErrorMessage(`Push failed: ${msg}`);
  }
}
```

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/commands/push.ts
git commit -m "feat(aic-studio): aic-studio.sync.push command (single journey)"
```

---

## Task 11: Promote commands (add to task, run task, archive task)

**Files:**
- Create: `aic-studio/src/commands/promote.ts`

- [ ] **Step 1: Implementation** (Write tool):

```typescript
// src/commands/promote.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  getEnvironmentByName,
  listEnvironments
} from "../core/db/environments";
import {
  addItemToTask,
  createPromotionTask,
  listActiveTasks,
  listItemsInTask,
  setTaskStatus,
  type TaskItem
} from "../core/db/promotionTasks";
import type { SecretStore } from "../core/env/secrets";
import { createTokenCache, fetchAccessToken } from "../core/aic/auth";
import { pushPromotionTask } from "../core/push/pushPromotionTask";
import { startOperation, finishOperation } from "../core/db/opHistory";
import type { JourneyNode } from "../providers/envTree";
import type { TaskNode } from "../providers/promotionTasksTree";
import { log, logError } from "../logging/output";

type Deps = {
  db: Database;
  secrets: SecretStore;
  globalStoragePath: string;
  onChange: () => void;
};

export function registerPromoteCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.promote.addToTask", (node?: JourneyNode) =>
      addToTaskCommand(deps, node)
    ),
    vscode.commands.registerCommand("aic-studio.promote.runTask", (node?: TaskNode) =>
      runTaskCommand(deps, node)
    ),
    vscode.commands.registerCommand("aic-studio.promote.archiveTask", (node?: TaskNode) =>
      archiveTaskCommand(deps, node)
    )
  );
}

async function addToTaskCommand(deps: Deps, node?: JourneyNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage(
      "Right-click a journey in the Environments tree to add it to a promotion task."
    );
    return;
  }
  const active = listActiveTasks(deps.db).filter((t) => t.sourceEnv === node.envName);
  const NEW_TASK = "$(plus) New task…";
  const choices: vscode.QuickPickItem[] = [
    { label: NEW_TASK, description: `from ${node.envName}` },
    ...active.map((t) => ({ label: t.name, description: `from ${t.sourceEnv} · #${t.id}` }))
  ];
  const pick = await vscode.window.showQuickPick(choices, {
    placeHolder: `Add ${node.realm}/${node.journeyId} to which promotion task?`
  });
  if (!pick) return;

  let taskId: number;
  if (pick.label === NEW_TASK) {
    const name = await vscode.window.showInputBox({ prompt: "Promotion task name" });
    if (!name) return;
    taskId = createPromotionTask(deps.db, { name, sourceEnv: node.envName });
  } else {
    const t = active.find((a) => a.name === pick.label);
    if (!t) return;
    taskId = t.id;
  }

  const item: TaskItem = {
    realm: node.realm,
    resourceType: "journey",
    resourceId: node.journeyId
  };
  addItemToTask(deps.db, taskId, item);
  log(`promote.addToTask: task ${taskId} += ${item.realm}/${item.resourceId}`);
  deps.onChange();
  void vscode.window.showInformationMessage(
    `Added ${node.realm}/${node.journeyId} to promotion task`
  );
}

async function runTaskCommand(deps: Deps, node?: TaskNode): Promise<void> {
  let taskId: number;
  let taskName: string;
  let sourceEnv: string;
  if (node) {
    taskId = node.task.id;
    taskName = node.task.name;
    sourceEnv = node.task.sourceEnv;
  } else {
    const tasks = listActiveTasks(deps.db);
    if (tasks.length === 0) {
      void vscode.window.showInformationMessage("No active promotion tasks.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.name, description: `#${t.id} · from ${t.sourceEnv}`, taskId: t.id })),
      { placeHolder: "Run which promotion task?" }
    );
    if (!pick) return;
    const chosen = tasks.find((t) => t.id === pick.taskId)!;
    taskId = chosen.id;
    taskName = chosen.name;
    sourceEnv = chosen.sourceEnv;
  }

  const items = listItemsInTask(deps.db, taskId);
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`Task "${taskName}" has no items.`);
    return;
  }

  const others = listEnvironments(deps.db).filter((e) => e.name !== sourceEnv);
  if (others.length === 0) {
    void vscode.window.showInformationMessage("No target env available.");
    return;
  }
  const targetPick = await vscode.window.showQuickPick(
    others.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: `Push "${taskName}" (${items.length} items) to which env?` }
  );
  if (!targetPick) return;
  const targetEnv = getEnvironmentByName(deps.db, targetPick.name);
  if (!targetEnv) return;
  const clientSecret = await deps.secrets.get(targetPick.name, "client-secret");
  if (!clientSecret) {
    void vscode.window.showErrorMessage(`No client secret configured for "${targetPick.name}".`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Push ${items.length} items from "${taskName}" to "${targetEnv.label}"?`,
    { modal: true },
    "Push"
  );
  if (confirm !== "Push") return;

  const opId = startOperation(deps.db, {
    envName: targetPick.name,
    opKind: "promote",
    scope: `task:${taskId}`
  });
  log(`promote.runTask start: task ${taskId} → ${targetPick.name} (${items.length} items)`);

  try {
    const tokenCache = createTokenCache(() =>
      fetchAccessToken({
        tenantUrl: targetEnv.tenantUrl,
        clientId: targetEnv.clientId,
        clientSecret
      })
    );
    const summary = await pushPromotionTask({
      globalStoragePath: deps.globalStoragePath,
      sourceEnvName: sourceEnv,
      targetTenantUrl: targetEnv.tenantUrl,
      targetTokenCache: tokenCache,
      items
    });
    const msg = `pushed ${summary.successCount}, failed ${summary.failureCount}, skipped ${summary.skippedCount}`;
    finishOperation(
      deps.db,
      opId,
      summary.failureCount === 0 ? "success" : "failure",
      msg
    );
    log(`promote.runTask done: ${msg}`);
    if (summary.failureCount === 0) {
      void vscode.window.showInformationMessage(`Promoted "${taskName}" to "${targetEnv.label}" — ${msg}`);
    } else {
      void vscode.window.showWarningMessage(
        `Promoted "${taskName}" with errors — ${msg}. See OutputChannel for details.`
      );
      for (const f of summary.failures) {
        logError(`item failed: ${f.item.realm}/${f.item.resourceId}`, new Error(f.error));
      }
    }
    deps.onChange();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishOperation(deps.db, opId, "failure", msg);
    logError(`promote.runTask failed`, err);
    void vscode.window.showErrorMessage(`Promote failed: ${msg}`);
  }
}

async function archiveTaskCommand(deps: Deps, node?: TaskNode): Promise<void> {
  let taskId: number;
  let taskName: string;
  if (node) {
    taskId = node.task.id;
    taskName = node.task.name;
  } else {
    const tasks = listActiveTasks(deps.db);
    if (tasks.length === 0) {
      void vscode.window.showInformationMessage("No active tasks to archive.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.name, description: `#${t.id}`, taskId: t.id })),
      { placeHolder: "Archive which task?" }
    );
    if (!pick) return;
    const chosen = tasks.find((t) => t.id === pick.taskId)!;
    taskId = chosen.id;
    taskName = chosen.name;
  }
  setTaskStatus(deps.db, taskId, "archived");
  log(`promote.archiveTask: ${taskId} (${taskName})`);
  deps.onChange();
  void vscode.window.showInformationMessage(`Archived "${taskName}"`);
}
```

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/commands/promote.ts
git commit -m "feat(aic-studio): promote commands (addToTask, runTask, archiveTask)"
```

---

## Task 12: package.json contributes (4 new commands + menus)

**Files:** Modify `aic-studio/package.json`

- [ ] **Step 1: Read** to find the existing commands array and menus.

- [ ] **Step 2: Add 4 new commands** at the end of the `commands` array (before its `]`):

```json
      ,
      { "command": "aic-studio.sync.push", "title": "AIC Studio: Push to environment…", "category": "AIC Studio" },
      { "command": "aic-studio.promote.addToTask", "title": "AIC Studio: Add to promotion task…", "category": "AIC Studio" },
      { "command": "aic-studio.promote.runTask", "title": "AIC Studio: Run promotion task…", "category": "AIC Studio", "icon": "$(rocket)" },
      { "command": "aic-studio.promote.archiveTask", "title": "AIC Studio: Archive promotion task…", "category": "AIC Studio" }
```

- [ ] **Step 3: Extend `menus`.** Replace the existing `menus` object so it reads:

```json
    "menus": {
      "view/title": [
        { "command": "aic-studio.env.add", "when": "view == aic-studio.environments", "group": "navigation@1" },
        { "command": "aic-studio.sync.pull", "when": "view == aic-studio.environments", "group": "navigation@2" }
      ],
      "view/item/context": [
        { "command": "aic-studio.sync.pull", "when": "viewItem == aic-studio.env", "group": "inline" },
        { "command": "aic-studio.compare.withEnv", "when": "viewItem == aic-studio.journey", "group": "1_compare" },
        { "command": "aic-studio.sync.push", "when": "viewItem == aic-studio.journey", "group": "1_compare" },
        { "command": "aic-studio.promote.addToTask", "when": "viewItem == aic-studio.journey", "group": "2_promote" },
        { "command": "aic-studio.promote.runTask", "when": "viewItem == aic-studio.promotionTask", "group": "inline" },
        { "command": "aic-studio.promote.archiveTask", "when": "viewItem == aic-studio.promotionTask", "group": "2_archive" }
      ]
    },
```

- [ ] **Step 4: Validate JSON**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo OK
```

- [ ] **Step 5: Commit**

```bash
git add aic-studio/package.json
git commit -m "feat(aic-studio): contribute push + promote commands and menus"
```

---

## Task 13: Wire commands + real Promotion Tasks tree into extension.ts

**Files:** Modify `aic-studio/src/extension.ts`

- [ ] **Step 1: Read extension.ts**.

- [ ] **Step 2: Edit imports** — replace the import line:

```typescript
import {
  promotionTasksTree,
  historyTree,
  monitorsTree,
  logsTree
} from "./providers/placeholderTrees";
```

with:

```typescript
import {
  historyTree,
  monitorsTree,
  logsTree
} from "./providers/placeholderTrees";
import { PromotionTasksTreeProvider } from "./providers/promotionTasksTree";
import { registerPushCommands } from "./commands/push";
import { registerPromoteCommands } from "./commands/promote";
```

- [ ] **Step 3: Edit activation body.** Inside `activate()`, after the `envTree` + `statusBar` instantiation:

a) Add this line right after `const envTree = new EnvironmentsTreeProvider(db, ctx.globalStorageUri.fsPath);`:

```typescript
    const promotionTasksTreeProvider = new PromotionTasksTreeProvider(db);
```

b) Replace the line `vscode.window.registerTreeDataProvider("aic-studio.promotionTasks", promotionTasksTree),` with:

```typescript
      vscode.window.registerTreeDataProvider("aic-studio.promotionTasks", promotionTasksTreeProvider),
```

c) After the existing `registerCompareCommands(ctx, { db });` line, add:

```typescript
    registerPushCommands(ctx, {
      db,
      secrets,
      globalStoragePath: ctx.globalStorageUri.fsPath,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        scmRegistry.refreshChanges();
      }
    });

    registerPromoteCommands(ctx, {
      db,
      secrets,
      globalStoragePath: ctx.globalStorageUri.fsPath,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        promotionTasksTreeProvider.refresh();
      }
    });
```

d) Update the existing `onChange` callbacks for `registerEnvCommands` and `registerSyncCommands` to also refresh `promotionTasksTreeProvider`. Add `promotionTasksTreeProvider.refresh();` to both callbacks.

- [ ] **Step 4: Build**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/extension.ts
git commit -m "feat(aic-studio): wire push + promote commands, real PromotionTasks tree"
```

---

## Task 14: Integration test — push command

**Files:**
- Create: `aic-studio/tests/integration/suite/pushFlow.test.ts`
- Modify: `aic-studio/esbuild.config.mjs` (add entry point)

- [ ] **Step 1: Write test:**

```typescript
// tests/integration/suite/pushFlow.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Push flow (command surface)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("sync.push command is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.sync.push"));
  });

  test("sync.push without a node argument informs the user gracefully", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.sync.push"))
    );
  });
});
```

- [ ] **Step 2: Add to esbuild.config.mjs entry points** (the integrationTestConfig.entryPoints array).

- [ ] **Step 3: Run integration tests**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio && npm run test:integration
```

If native module ABI mismatch: `npx electron-rebuild --force -v 39.8.8 -m node_modules/better-sqlite3 -w better-sqlite3` then re-run.

Expected: 12 prior + 2 new = 14 tests pass.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/tests/integration/suite/pushFlow.test.ts aic-studio/esbuild.config.mjs
git commit -m "test(aic-studio): integration test for sync.push command"
```

---

## Task 15: Integration test — promote command lifecycle

**Files:**
- Create: `aic-studio/tests/integration/suite/promoteFlow.test.ts`
- Modify: `aic-studio/esbuild.config.mjs`

- [ ] **Step 1: Write test:**

```typescript
// tests/integration/suite/promoteFlow.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Promote command lifecycle", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("promote.addToTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.addToTask"));
  });

  test("promote.runTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.runTask"));
  });

  test("promote.archiveTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.archiveTask"));
  });

  test("promote.runTask with no tasks does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.promote.runTask"))
    );
  });

  test("promote.archiveTask with no tasks does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.promote.archiveTask"))
    );
  });
});
```

- [ ] **Step 2: Add to esbuild.config.mjs entry points.**

- [ ] **Step 3: Run integration tests**

Expected: 14 prior + 5 new = 19 tests pass.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/tests/integration/suite/promoteFlow.test.ts aic-studio/esbuild.config.mjs
git commit -m "test(aic-studio): integration test for promote commands"
```

---

## Task 16: CHANGELOG entry for M3

**Files:** Modify `aic-studio/CHANGELOG.md`

- [ ] **Step 1: Insert above the M2 section:**

```markdown
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

```

- [ ] **Step 2: Commit**

```bash
git add aic-studio/CHANGELOG.md
git commit -m "docs(aic-studio): CHANGELOG entry for M3"
```

---

## Task 17: M3 acceptance gate

**Files:** none (verification only — NO COMMITS)

- [ ] **Step 1: Clean reinstall + rebuild**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio
rm -rf node_modules out coverage
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
```

- [ ] **Step 2: typecheck → lint → unit → build → integration**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio
npm run typecheck
npm run lint
npm rebuild better-sqlite3
npm test -- --run
npm run build
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
npm run test:integration
```

Expected:
- typecheck 0; lint 0
- unit ~67 passing (54 from M2 + ~13 new in M3)
- build clean
- integration 19 passing (12 from M2 + 7 from M3 [2 push + 5 promote])

- [ ] **Step 3: Coverage**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3/aic-studio
npm rebuild better-sqlite3
npm test -- --run --coverage
```

Expected: `src/core/` ≥85/85/85/75.

- [ ] **Step 4: Git state**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m3
git status                                # clean
git log --oneline -18                     # ~16 M3 commits
git branch --show-current                 # aic-studio/m3
```

- [ ] **Step 5: NO COMMIT.** Manual F5 smoke deferred to user.

---

## Self-Review

**Spec coverage:**
- §4 command surface — `aic-studio.sync.push` (Task 10), `aic-studio.promote.{addToTask,runTask,archiveTask}` (Task 11) match the spec. ✓
- §2 UI mapping — Promote = SCM panel + Webview Panel; M3 ships SCM Changes population (Task 9) and right-click flows; webview wizard explicitly deferred to M3.1. ✓
- §3 data — `promotion_tasks` schema (Task 1), `op_history` extended via use (no schema change needed, Task 10/11). ✓
- §6 testing — TDD on every core module (Tasks 2, 3, 4, 5, 6, 7), integration tests for command registration (Tasks 14, 15). ✓
- §1 architecture — Two-layer boundary preserved: `core/push/`, `core/diff/`, `core/db/promotionTasks.ts` are all vscode-free. ✓

**Placeholder scan:** None.

**Type consistency:** `TaskItem` defined in Task 2 (`promotionTasks.ts`), used in Tasks 6 (`pushPromotionTask`), 8 (tree), 11 (promote command). `PushTaskSummary` defined in Task 6, used in Task 11. `ChangedItem` defined in Task 7, used in Task 9. `TaskNode` defined in Task 8, referenced in Task 11. `PromotionTaskRow` defined in Task 2, used in Task 8.

**Deferred to M3.1+:**
- Wizard webview (spec calls it "optional")
- Scripts / themes / federation push (M2/M3 are journey-only; same pattern extends)
- Conflict detection (remote-changed-since-pull warning)
- Push undo / rollback

Plan ready for execution.
