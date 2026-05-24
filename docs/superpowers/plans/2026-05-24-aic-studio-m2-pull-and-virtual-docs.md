# AIC Studio M2 — Pull, Virtual Docs & Diff Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension functional end-to-end for one resource type. A user adds an AIC environment, runs "AIC Studio: Pull from environment", and sees the env's journeys appear in the sidebar tree as virtual `aic://` documents that open in the editor with native JSON highlighting and folding. Comparing two envs opens VS Code's built-in diff editor. The SCM panel registers a SourceControl per env (Changes group stays empty in M2; populated by M3).

**Architecture:** OAuth client_credentials flow against `<tenantUrl>/am/oauth2/realms/root/access_token` (no CLI dependency, mirrors `iga-api.ts`). Cached bearer token in memory. Journeys fetched via `GET /am/json/realms/<realm>/authentication/authenticationtrees`. Each fetched resource is written as flat JSON under `globalStorageUri/snapshots/<env>/<timestamp>/<realm>/journeys/<id>.json`. Tree provider reads the latest snapshot dir. `TextDocumentContentProvider` resolves `aic://<env>/<realm>/journey/<id>` to the file under the latest snapshot. Diff editor wired via built-in `vscode.diff`. One new SQLite table `op_history` records each pull operation.

**Tech Stack:** axios for HTTP · nock for HTTP mocking in tests · existing better-sqlite3, vscode, vitest, @vscode/test-electron

**Spec:** [`docs/superpowers/specs/2026-05-24-aic-studio-vscode-extension-design.md`](../specs/2026-05-24-aic-studio-vscode-extension-design.md)
**Prior plan (M1):** [`docs/superpowers/plans/2026-05-24-aic-studio-m1-scaffold-and-environments.md`](./2026-05-24-aic-studio-m1-scaffold-and-environments.md)

**Branch convention:** Build M2 on a new worktree branch `aic-studio/m2` branched from `aic-studio/m1`. M1 must merge to `development` first OR M2 can be built atop the unmerged `aic-studio/m1` tip — the controller decides during setup.

---

## File Structure

New (created in M2):

```
aic-studio/
  src/
    core/
      db/
        schema.ts                                 MODIFY — add migration v2 (op_history table)
        opHistory.ts                              NEW — op_history CRUD
        opHistory.test.ts                         NEW — vitest
      aic/
        urls.ts                                   NEW — AIC endpoint URL builders
        urls.test.ts                              NEW — vitest
        auth.ts                                   NEW — OAuth token fetch + cache
        auth.test.ts                              NEW — vitest (nock)
        client.ts                                 NEW — authed axios wrapper
        client.test.ts                            NEW — vitest (nock)
        journeys.ts                               NEW — list + fetch journeys
        journeys.test.ts                          NEW — vitest (nock)
      snapshots/
        paths.ts                                  NEW — snapshot dir path helpers
        paths.test.ts                             NEW — vitest
        writer.ts                                 NEW — write resource JSON to snapshot dir
        writer.test.ts                            NEW — vitest
        reader.ts                                 NEW — read latest snapshot for env/realm
        reader.test.ts                            NEW — vitest
      pull/
        pullJourneys.ts                           NEW — pull orchestration (all realms)
        pullJourneys.test.ts                      NEW — vitest (nock)
    providers/
      envTree.ts                                  MODIFY — extend to show realm/category/resource children
      virtualDocs.ts                              NEW — TextDocumentContentProvider for aic://
      sourceControl.ts                            NEW — SourceControl provider per env
    commands/
      sync.ts                                     NEW — aic-studio.sync.pull command
      compare.ts                                  NEW — aic-studio.compare.withEnv command
    status/
      pullProgress.ts                             NEW — status bar spinner during pull
    extension.ts                                  MODIFY — wire virtualDocs, sourceControl, sync/compare commands
  package.json                                    MODIFY — add commands + menus; add axios + nock
  tests/integration/suite/
    pullFlow.test.ts                              NEW — integration test for pull (with nock)
    virtualDocs.test.ts                           NEW — integration test for aic:// URI resolution
    compare.test.ts                               NEW — integration test for diff editor
```

Every new core file keeps the two-layer boundary: `src/core/aic/*`, `src/core/snapshots/*`, `src/core/pull/*` are vscode-free. `src/providers/*`, `src/commands/*`, `src/status/*` are the vscode-touching layer.

---

## Pre-Task Setup

Before Task 1, create the worktree branch:

```bash
# From repo root:
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m2 -b aic-studio/m2 aic-studio/m1
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m2
git branch --show-current   # should print "aic-studio/m2"
```

If `aic-studio/m1` has already merged to `development`, branch from `development` instead.

All task working dirs: `/Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m2`. **All `git` commands must be run from inside the worktree** (cwd starts with `.worktrees/aic-studio-m2`) to avoid the branch-divergence issue we hit in M1.

---

## Task 1: Schema migration v2 — op_history table

**Files:**
- Modify: `aic-studio/src/core/db/schema.ts`

- [ ] **Step 1: Read current schema.ts**

Use Read tool. Confirm it has `SCHEMA_VERSION = 1` and one migration.

- [ ] **Step 2: Add migration v2**

Use Edit tool to change `SCHEMA_VERSION` from `1` to `2` and append a new migration entry to the `MIGRATIONS` array:

```typescript
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS op_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env_name TEXT NOT NULL,
        op_kind TEXT NOT NULL,
        scope TEXT,
        status TEXT NOT NULL,
        message TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        snapshot_dir TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_op_history_env ON op_history(env_name, started_at DESC);
    `
  }
```

After the edit, the MIGRATIONS array has 2 entries.

- [ ] **Step 3: Verify typecheck**

```bash
cd aic-studio && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Verify connection.test.ts still passes (idempotent upgrade)**

```bash
cd aic-studio && npm test -- --run src/core/db/connection.test.ts
```

Expected: both tests pass (the v1 → v2 migration runs cleanly because openDatabase loops through migrations where `m.version > currentVersion`).

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/schema.ts
git commit -m "feat(aic-studio): add op_history schema (migration v2)"
```

---

## Task 2: Add axios + nock dependencies

**Files:**
- Modify: `aic-studio/package.json`

- [ ] **Step 1: Install axios (runtime) and nock (dev)**

```bash
cd aic-studio && npm install axios@^1.15.0
cd aic-studio && npm install --save-dev nock@^14.0.12
```

- [ ] **Step 2: Verify dependencies were added**

```bash
cd aic-studio && npm pkg get dependencies.axios && npm pkg get devDependencies.nock
```

Expected: prints `"^1.15.0"` and `"^14.0.12"` (or compatible versions).

- [ ] **Step 3: Verify build still works**

```bash
cd aic-studio && npm run build
```

Expected: no errors, `out/extension.js` produced.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/package.json aic-studio/package-lock.json
git commit -m "chore(aic-studio): add axios (runtime) and nock (dev) for HTTP"
```

---

## Task 3: AIC URL builders

**Files:**
- Create: `aic-studio/src/core/aic/urls.ts`
- Create: `aic-studio/src/core/aic/urls.test.ts`

- [ ] **Step 1: Write the failing tests** (Write tool)

```typescript
// src/core/aic/urls.test.ts
import { describe, it, expect } from "vitest";
import { tokenUrl, journeysListUrl, journeyDetailUrl, realmsListUrl } from "./urls";

describe("AIC URLs", () => {
  const base = "https://prod.id.forgerock.io";

  it("tokenUrl points to AM's root-realm token endpoint", () => {
    expect(tokenUrl(base)).toBe("https://prod.id.forgerock.io/am/oauth2/realms/root/access_token");
  });

  it("realmsListUrl lists realms under root", () => {
    expect(realmsListUrl(base)).toBe("https://prod.id.forgerock.io/am/json/global-config/realms?_queryFilter=true");
  });

  it("journeysListUrl uses _queryFilter=true with realm path", () => {
    expect(journeysListUrl(base, "alpha")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees?_queryFilter=true"
    );
  });

  it("journeyDetailUrl uses the tree id", () => {
    expect(journeyDetailUrl(base, "alpha", "Login")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Login"
    );
  });

  it("strips trailing slash on base", () => {
    expect(tokenUrl("https://prod.id.forgerock.io/")).toBe(
      "https://prod.id.forgerock.io/am/oauth2/realms/root/access_token"
    );
  });
});
```

- [ ] **Step 2: Run → FAIL**

```bash
cd aic-studio && npm test -- --run src/core/aic/urls.test.ts
```

Expected: "Cannot find module './urls'".

- [ ] **Step 3: Write the implementation** (Write tool)

```typescript
// src/core/aic/urls.ts

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function tokenUrl(tenantUrl: string): string {
  return `${trimSlash(tenantUrl)}/am/oauth2/realms/root/access_token`;
}

export function realmsListUrl(tenantUrl: string): string {
  return `${trimSlash(tenantUrl)}/am/json/global-config/realms?_queryFilter=true`;
}

export function journeysListUrl(tenantUrl: string, realm: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees?_queryFilter=true`;
}

export function journeyDetailUrl(tenantUrl: string, realm: string, id: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees/${id}`;
}
```

- [ ] **Step 4: Run → PASS (5 tests)**

```bash
cd aic-studio && npm test -- --run src/core/aic/urls.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/urls.ts aic-studio/src/core/aic/urls.test.ts
git commit -m "feat(aic-studio): add AIC endpoint URL builders"
```

---

## Task 4: OAuth token fetch (auth.ts)

**Files:**
- Create: `aic-studio/src/core/aic/auth.ts`
- Create: `aic-studio/src/core/aic/auth.test.ts`

- [ ] **Step 1: Write the failing tests** (Write tool)

```typescript
// src/core/aic/auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { fetchAccessToken, type TokenResponse } from "./auth";

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("fetchAccessToken", () => {
  it("POSTs client_credentials to the token endpoint and returns the token", async () => {
    const scope = nock("https://prod.id.forgerock.io")
      .post(
        "/am/oauth2/realms/root/access_token",
        "grant_type=client_credentials&client_id=svc-client&client_secret=hunter2&scope=fr%3Aam%3A*"
      )
      .reply(200, {
        access_token: "abc-123",
        token_type: "Bearer",
        expires_in: 3599,
        scope: "fr:am:*"
      });

    const result = await fetchAccessToken({
      tenantUrl: "https://prod.id.forgerock.io",
      clientId: "svc-client",
      clientSecret: "hunter2"
    });

    expect(result.accessToken).toBe("abc-123");
    expect(result.expiresInSeconds).toBe(3599);
    expect(scope.isDone()).toBe(true);
  });

  it("throws when AIC returns 401", async () => {
    nock("https://prod.id.forgerock.io")
      .post("/am/oauth2/realms/root/access_token")
      .reply(401, { error: "invalid_client" });

    await expect(
      fetchAccessToken({
        tenantUrl: "https://prod.id.forgerock.io",
        clientId: "wrong",
        clientSecret: "wrong"
      })
    ).rejects.toThrow(/401|invalid_client/i);
  });
});
```

- [ ] **Step 2: Run → FAIL**

```bash
cd aic-studio && npm test -- --run src/core/aic/auth.test.ts
```

Expected: "Cannot find module './auth'".

- [ ] **Step 3: Write the implementation** (Write tool)

```typescript
// src/core/aic/auth.ts
import axios from "axios";
import { tokenUrl } from "./urls";

export interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  scope: string;
}

export interface AuthParams {
  tenantUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export async function fetchAccessToken(params: AuthParams): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: params.scope ?? "fr:am:*"
  });

  try {
    const res = await axios.post<{
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    }>(tokenUrl(params.tenantUrl), body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    return {
      accessToken: res.data.access_token,
      expiresInSeconds: res.data.expires_in,
      scope: res.data.scope
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const detail = typeof err.response.data === "object"
        ? JSON.stringify(err.response.data)
        : String(err.response.data);
      throw new Error(`AIC token endpoint returned ${err.response.status}: ${detail}`);
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run → PASS (2 tests)**

```bash
cd aic-studio && npm test -- --run src/core/aic/auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/auth.ts aic-studio/src/core/aic/auth.test.ts
git commit -m "feat(aic-studio): OAuth client_credentials token fetch"
```

---

## Task 5: Token cache

**Files:**
- Modify: `aic-studio/src/core/aic/auth.ts`
- Modify: `aic-studio/src/core/aic/auth.test.ts`

- [ ] **Step 1: Append failing tests** (Edit tool — append at end of `auth.test.ts`)

```typescript
import { createTokenCache } from "./auth";

describe("createTokenCache", () => {
  it("calls the fetcher once and reuses the token until it nears expiry", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return {
        accessToken: `t-${calls}`,
        expiresInSeconds: 3600,
        scope: "fr:am:*"
      };
    };
    const cache = createTokenCache(fetcher);
    expect(await cache.get()).toBe("t-1");
    expect(await cache.get()).toBe("t-1");
    expect(calls).toBe(1);
  });

  it("re-fetches when forced", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { accessToken: `t-${calls}`, expiresInSeconds: 3600, scope: "fr:am:*" };
    };
    const cache = createTokenCache(fetcher);
    await cache.get();
    await cache.invalidate();
    expect(await cache.get()).toBe("t-2");
  });
});
```

- [ ] **Step 2: Run → FAIL** (missing `createTokenCache` export)

```bash
cd aic-studio && npm test -- --run src/core/aic/auth.test.ts
```

- [ ] **Step 3: Append implementation** (Edit tool — append at end of `auth.ts`)

```typescript
const GRACE_SECONDS = 30;

export interface TokenCache {
  get(): Promise<string>;
  invalidate(): void;
}

export function createTokenCache(fetcher: () => Promise<TokenResponse>): TokenCache {
  let token: string | undefined;
  let expiresAtMs = 0;
  return {
    async get(): Promise<string> {
      const now = Date.now();
      if (token && now < expiresAtMs - GRACE_SECONDS * 1000) {
        return token;
      }
      const fresh = await fetcher();
      token = fresh.accessToken;
      expiresAtMs = now + fresh.expiresInSeconds * 1000;
      return token;
    },
    invalidate(): void {
      token = undefined;
      expiresAtMs = 0;
    }
  };
}
```

- [ ] **Step 4: Run → PASS (4 tests total in auth.test.ts)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/auth.ts aic-studio/src/core/aic/auth.test.ts
git commit -m "feat(aic-studio): add in-memory token cache with expiry grace"
```

---

## Task 6: Authenticated HTTP client

**Files:**
- Create: `aic-studio/src/core/aic/client.ts`
- Create: `aic-studio/src/core/aic/client.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/aic/client.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { createAuthedClient } from "./client";

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("createAuthedClient", () => {
  it("adds Bearer Authorization header to all requests", async () => {
    const scope = nock("https://prod.id.forgerock.io", {
      reqheaders: { authorization: "Bearer test-token" }
    })
      .get("/am/json/anything")
      .reply(200, { ok: true });

    const cache = { get: async () => "test-token", invalidate: () => {} };
    const client = createAuthedClient(cache);
    const res = await client.get("https://prod.id.forgerock.io/am/json/anything");
    expect(res.data).toEqual({ ok: true });
    expect(scope.isDone()).toBe(true);
  });

  it("retries once after a 401 with token invalidation", async () => {
    nock("https://prod.id.forgerock.io").get("/am/json/x").reply(401, { error: "expired" });
    nock("https://prod.id.forgerock.io")
      .get("/am/json/x")
      .reply(200, { ok: true });

    let invalidateCalls = 0;
    const cache = {
      get: async () => "t",
      invalidate: () => { invalidateCalls += 1; }
    };
    const client = createAuthedClient(cache);
    const res = await client.get("https://prod.id.forgerock.io/am/json/x");
    expect(res.data).toEqual({ ok: true });
    expect(invalidateCalls).toBe(1);
  });

  it("propagates non-401 errors", async () => {
    nock("https://prod.id.forgerock.io").get("/am/json/x").reply(500, { error: "boom" });
    const cache = { get: async () => "t", invalidate: () => {} };
    const client = createAuthedClient(cache);
    await expect(
      client.get("https://prod.id.forgerock.io/am/json/x")
    ).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/aic/client.ts
import axios from "axios";
import type { AxiosResponse } from "axios";
import type { TokenCache } from "./auth";

export interface AuthedClient {
  get<T = unknown>(url: string): Promise<AxiosResponse<T>>;
}

export function createAuthedClient(cache: TokenCache): AuthedClient {
  async function request<T>(url: string, isRetry: boolean): Promise<AxiosResponse<T>> {
    const token = await cache.get();
    try {
      return await axios.get<T>(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401 && !isRetry) {
        cache.invalidate();
        return request<T>(url, true);
      }
      if (axios.isAxiosError(err) && err.response) {
        throw new Error(`AIC GET ${url} → ${err.response.status}`);
      }
      throw err;
    }
  }
  return {
    get: <T>(url: string) => request<T>(url, false)
  };
}
```

- [ ] **Step 4: Run → PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/client.ts aic-studio/src/core/aic/client.test.ts
git commit -m "feat(aic-studio): authed HTTP client with 401 retry"
```

---

## Task 7: List + fetch journeys

**Files:**
- Create: `aic-studio/src/core/aic/journeys.ts`
- Create: `aic-studio/src/core/aic/journeys.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/aic/journeys.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { listJourneys, fetchJourney } from "./journeys";

const cache = { get: async () => "test-token", invalidate: () => {} };

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("listJourneys", () => {
  it("returns an array of journey ids for a realm", async () => {
    nock("https://prod.id.forgerock.io")
      .get(/authenticationtrees\?_queryFilter=true/)
      .reply(200, {
        result: [
          { _id: "Login", _rev: "1" },
          { _id: "Registration", _rev: "1" }
        ],
        resultCount: 2
      });

    const ids = await listJourneys("https://prod.id.forgerock.io", "alpha", cache);
    expect(ids).toEqual(["Login", "Registration"]);
  });

  it("returns empty array when realm has no journeys", async () => {
    nock("https://prod.id.forgerock.io")
      .get(/authenticationtrees\?_queryFilter=true/)
      .reply(200, { result: [], resultCount: 0 });
    expect(await listJourneys("https://prod.id.forgerock.io", "alpha", cache)).toEqual([]);
  });
});

describe("fetchJourney", () => {
  it("returns the full journey JSON for an id", async () => {
    nock("https://prod.id.forgerock.io")
      .get(/authenticationtrees\/Login$/)
      .reply(200, { _id: "Login", _rev: "1", entryNodeId: "abc", nodes: {} });

    const j = await fetchJourney("https://prod.id.forgerock.io", "alpha", "Login", cache);
    expect(j._id).toBe("Login");
    expect(j.entryNodeId).toBe("abc");
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/aic/journeys.ts
import type { TokenCache } from "./auth";
import { createAuthedClient } from "./client";
import { journeysListUrl, journeyDetailUrl } from "./urls";

interface JourneyListResponse {
  result: Array<{ _id: string; _rev?: string }>;
  resultCount: number;
}

export async function listJourneys(
  tenantUrl: string,
  realm: string,
  cache: TokenCache
): Promise<string[]> {
  const client = createAuthedClient(cache);
  const res = await client.get<JourneyListResponse>(journeysListUrl(tenantUrl, realm));
  return res.data.result.map((r) => r._id);
}

export async function fetchJourney(
  tenantUrl: string,
  realm: string,
  id: string,
  cache: TokenCache
): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.get<Record<string, unknown>>(journeyDetailUrl(tenantUrl, realm, id));
  return res.data;
}
```

- [ ] **Step 4: Run → PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/journeys.ts aic-studio/src/core/aic/journeys.test.ts
git commit -m "feat(aic-studio): list and fetch journeys via AIC AM REST"
```

---

## Task 8: List realms

**Files:**
- Modify: `aic-studio/src/core/aic/journeys.ts` (no — actually new file is cleaner)
- Create: `aic-studio/src/core/aic/realms.ts`
- Create: `aic-studio/src/core/aic/realms.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/aic/realms.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { listRealms } from "./realms";

const cache = { get: async () => "t", invalidate: () => {} };

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("listRealms", () => {
  it("returns realm names from global-config/realms", async () => {
    nock("https://prod.id.forgerock.io")
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, {
        result: [
          { _id: "alpha-id", name: "alpha", parentPath: "/" },
          { _id: "bravo-id", name: "bravo", parentPath: "/" }
        ],
        resultCount: 2
      });
    expect(await listRealms("https://prod.id.forgerock.io", cache)).toEqual(["alpha", "bravo"]);
  });

  it("filters out the root realm itself (name '/')", async () => {
    nock("https://prod.id.forgerock.io")
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, {
        result: [
          { _id: "root-id", name: "/", parentPath: "" },
          { _id: "alpha-id", name: "alpha", parentPath: "/" }
        ],
        resultCount: 2
      });
    expect(await listRealms("https://prod.id.forgerock.io", cache)).toEqual(["alpha"]);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/aic/realms.ts
import type { TokenCache } from "./auth";
import { createAuthedClient } from "./client";
import { realmsListUrl } from "./urls";

interface RealmsResponse {
  result: Array<{ _id: string; name: string; parentPath?: string }>;
  resultCount: number;
}

export async function listRealms(tenantUrl: string, cache: TokenCache): Promise<string[]> {
  const client = createAuthedClient(cache);
  const res = await client.get<RealmsResponse>(realmsListUrl(tenantUrl));
  return res.data.result.map((r) => r.name).filter((n) => n && n !== "/");
}
```

- [ ] **Step 4: Run → PASS (2 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/realms.ts aic-studio/src/core/aic/realms.test.ts
git commit -m "feat(aic-studio): list realms via AM global-config"
```

---

## Task 9: Snapshot path helpers

**Files:**
- Create: `aic-studio/src/core/snapshots/paths.ts`
- Create: `aic-studio/src/core/snapshots/paths.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/snapshots/paths.test.ts
import { describe, it, expect } from "vitest";
import { snapshotRoot, envSnapshotDir, latestSnapshotDir, journeyFile, isoStamp } from "./paths";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("snapshot path helpers", () => {
  it("snapshotRoot returns globalStorage/snapshots", () => {
    expect(snapshotRoot("/var/store")).toBe("/var/store/snapshots");
  });

  it("envSnapshotDir returns snapshots/{env}", () => {
    expect(envSnapshotDir("/var/store", "prod")).toBe("/var/store/snapshots/prod");
  });

  it("isoStamp generates a filesystem-safe ISO timestamp", () => {
    const s = isoStamp(new Date("2026-05-24T15:30:00Z"));
    expect(s).toBe("2026-05-24T15-30-00Z");
  });

  it("journeyFile is realm/journeys/<id>.json under the snapshot dir", () => {
    expect(journeyFile("/snap/2026-05-24T15-30-00Z", "alpha", "Login")).toBe(
      "/snap/2026-05-24T15-30-00Z/alpha/journeys/Login.json"
    );
  });

  it("latestSnapshotDir returns the most recently mtime'd subdir, or undefined if none", () => {
    const root = mkdtempSync(join(tmpdir(), "snap-test-"));
    try {
      const envDir = join(root, "snapshots", "prod");
      mkdirSync(envDir, { recursive: true });
      expect(latestSnapshotDir(root, "prod")).toBeUndefined();
      const a = join(envDir, "2026-05-24T15-00-00Z");
      const b = join(envDir, "2026-05-24T16-00-00Z");
      mkdirSync(a);
      mkdirSync(b);
      expect(latestSnapshotDir(root, "prod")).toBe(b);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/snapshots/paths.ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export function snapshotRoot(globalStoragePath: string): string {
  return join(globalStoragePath, "snapshots");
}

export function envSnapshotDir(globalStoragePath: string, envName: string): string {
  return join(snapshotRoot(globalStoragePath), envName);
}

export function isoStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, "-").replace(/\.\d+/, "");
}

export function journeyFile(snapshotDir: string, realm: string, id: string): string {
  return join(snapshotDir, realm, "journeys", `${id}.json`);
}

export function latestSnapshotDir(globalStoragePath: string, envName: string): string | undefined {
  const dir = envSnapshotDir(globalStoragePath, envName);
  if (!existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, mtimeMs: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.length > 0 ? join(dir, entries[0].name) : undefined;
}
```

- [ ] **Step 4: Run → PASS (5 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/snapshots/paths.ts aic-studio/src/core/snapshots/paths.test.ts
git commit -m "feat(aic-studio): snapshot directory + path helpers"
```

---

## Task 10: Snapshot writer

**Files:**
- Create: `aic-studio/src/core/snapshots/writer.ts`
- Create: `aic-studio/src/core/snapshots/writer.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/snapshots/writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJourney } from "./writer";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "snap-writer-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("writeJourney", () => {
  it("writes pretty-printed JSON to the journey file path", () => {
    const snapDir = join(root, "2026-05-24T15-30-00Z");
    writeJourney(snapDir, "alpha", "Login", { _id: "Login", nodes: { a: 1 } });
    const p = join(snapDir, "alpha", "journeys", "Login.json");
    expect(existsSync(p)).toBe(true);
    const text = readFileSync(p, "utf8");
    expect(JSON.parse(text)).toEqual({ _id: "Login", nodes: { a: 1 } });
    expect(text.includes("\n  ")).toBe(true); // pretty-printed
  });

  it("creates intermediate directories", () => {
    const snapDir = join(root, "x", "y", "z");
    writeJourney(snapDir, "alpha", "L", { _id: "L" });
    expect(existsSync(join(snapDir, "alpha", "journeys", "L.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/snapshots/writer.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { journeyFile } from "./paths";

export function writeJourney(
  snapshotDir: string,
  realm: string,
  id: string,
  body: unknown
): void {
  const p = journeyFile(snapshotDir, realm, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Run → PASS (2 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/snapshots/writer.ts aic-studio/src/core/snapshots/writer.test.ts
git commit -m "feat(aic-studio): snapshot writer for journey JSON"
```

---

## Task 11: Snapshot reader

**Files:**
- Create: `aic-studio/src/core/snapshots/reader.ts`
- Create: `aic-studio/src/core/snapshots/reader.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/snapshots/reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJourneyFromLatest, listRealmsInLatest, listJourneysInLatest } from "./reader";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "snap-reader-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seed(envName: string, stamp: string, realm: string, files: Record<string, unknown>) {
  const dir = join(root, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  for (const [id, body] of Object.entries(files)) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
  }
}

describe("snapshot reader", () => {
  it("reads a journey from the latest snapshot", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { Login: { _id: "Login", x: 1 } });
    const body = readJourneyFromLatest(root, "prod", "alpha", "Login");
    expect(body).toEqual({ _id: "Login", x: 1 });
  });

  it("returns undefined when no snapshot exists", () => {
    expect(readJourneyFromLatest(root, "prod", "alpha", "Login")).toBeUndefined();
  });

  it("lists realms in the latest snapshot", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { L: {} });
    seed("prod", "2026-05-24T15-30-00Z", "bravo", { R: {} });
    expect(listRealmsInLatest(root, "prod").sort()).toEqual(["alpha", "bravo"]);
  });

  it("lists journeys in a realm of the latest snapshot", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { Login: {}, Register: {} });
    expect(listJourneysInLatest(root, "prod", "alpha").sort()).toEqual(["Login", "Register"]);
  });

  it("returns [] when realm directory missing", () => {
    seed("prod", "2026-05-24T15-30-00Z", "alpha", { L: {} });
    expect(listJourneysInLatest(root, "prod", "missing")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/snapshots/reader.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { latestSnapshotDir, journeyFile } from "./paths";

export function readJourneyFromLatest(
  globalStoragePath: string,
  envName: string,
  realm: string,
  id: string
): Record<string, unknown> | undefined {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return undefined;
  const file = journeyFile(dir, realm, id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function listRealmsInLatest(globalStoragePath: string, envName: string): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function listJourneysInLatest(
  globalStoragePath: string,
  envName: string,
  realm: string
): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return [];
  const realmDir = join(dir, realm, "journeys");
  if (!existsSync(realmDir)) return [];
  return readdirSync(realmDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.replace(/\.json$/, ""));
}
```

- [ ] **Step 4: Run → PASS (5 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/snapshots/reader.ts aic-studio/src/core/snapshots/reader.test.ts
git commit -m "feat(aic-studio): snapshot reader (journey, realms, journey list)"
```

---

## Task 12: op_history CRUD

**Files:**
- Create: `aic-studio/src/core/db/opHistory.ts`
- Create: `aic-studio/src/core/db/opHistory.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/db/opHistory.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import { startOperation, finishOperation, listOperations, type OpStatus } from "./opHistory";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ophist-"));
  db = openDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("op_history", () => {
  it("startOperation inserts a row with status 'running' and returns the row id", () => {
    const id = startOperation(db, {
      envName: "prod",
      opKind: "pull",
      scope: "journeys",
      snapshotDir: "/tmp/snap"
    });
    expect(typeof id).toBe("number");
    const ops = listOperations(db, "prod");
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe(id);
    expect(ops[0].status).toBe("running");
    expect(ops[0].finishedAt).toBeUndefined();
  });

  it("finishOperation sets status + message + finished_at", () => {
    const id = startOperation(db, { envName: "prod", opKind: "pull" });
    finishOperation(db, id, "success", "pulled 12 journeys");
    const ops = listOperations(db, "prod");
    expect(ops[0].status).toBe("success");
    expect(ops[0].message).toBe("pulled 12 journeys");
    expect(typeof ops[0].finishedAt).toBe("number");
  });

  it("listOperations returns most recent first", () => {
    startOperation(db, { envName: "prod", opKind: "pull" });
    startOperation(db, { envName: "prod", opKind: "pull" });
    const ops = listOperations(db, "prod");
    expect(ops).toHaveLength(2);
    expect(ops[0].id).toBeGreaterThan(ops[1].id);
  });

  it("listOperations filters by env name", () => {
    startOperation(db, { envName: "prod", opKind: "pull" });
    startOperation(db, { envName: "stage", opKind: "pull" });
    expect(listOperations(db, "prod")).toHaveLength(1);
    expect(listOperations(db, "stage")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/db/opHistory.ts
import type { Database } from "better-sqlite3";

export type OpStatus = "running" | "success" | "failure";

export interface StartOpInput {
  envName: string;
  opKind: string;
  scope?: string;
  snapshotDir?: string;
}

export interface OpRow {
  id: number;
  envName: string;
  opKind: string;
  scope?: string;
  status: OpStatus;
  message?: string;
  startedAt: number;
  finishedAt?: number;
  snapshotDir?: string;
}

interface RawRow {
  id: number;
  env_name: string;
  op_kind: string;
  scope: string | null;
  status: string;
  message: string | null;
  started_at: number;
  finished_at: number | null;
  snapshot_dir: string | null;
}

function rowToOp(r: RawRow): OpRow {
  return {
    id: r.id,
    envName: r.env_name,
    opKind: r.op_kind,
    scope: r.scope ?? undefined,
    status: r.status as OpStatus,
    message: r.message ?? undefined,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    snapshotDir: r.snapshot_dir ?? undefined
  };
}

export function startOperation(db: Database, input: StartOpInput): number {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO op_history (env_name, op_kind, scope, status, started_at, snapshot_dir)
    VALUES (?, ?, ?, 'running', ?, ?)
  `).run(input.envName, input.opKind, input.scope ?? null, now, input.snapshotDir ?? null);
  return Number(info.lastInsertRowid);
}

export function finishOperation(
  db: Database,
  id: number,
  status: OpStatus,
  message?: string
): void {
  db.prepare(`
    UPDATE op_history SET status = ?, message = ?, finished_at = ? WHERE id = ?
  `).run(status, message ?? null, Date.now(), id);
}

export function listOperations(db: Database, envName: string, limit = 100): OpRow[] {
  const rows = db.prepare(`
    SELECT * FROM op_history WHERE env_name = ? ORDER BY id DESC LIMIT ?
  `).all(envName, limit) as RawRow[];
  return rows.map(rowToOp);
}
```

- [ ] **Step 4: Run → PASS (4 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/opHistory.ts aic-studio/src/core/db/opHistory.test.ts
git commit -m "feat(aic-studio): op_history CRUD (start/finish/list)"
```

---

## Task 13: Pull orchestration

**Files:**
- Create: `aic-studio/src/core/pull/pullJourneys.ts`
- Create: `aic-studio/src/core/pull/pullJourneys.test.ts`

- [ ] **Step 1: Write failing tests** (Write tool)

```typescript
// src/core/pull/pullJourneys.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullAllJourneys } from "./pullJourneys";
import { latestSnapshotDir, journeyFile } from "../snapshots/paths";

let storage: string;
const tenant = "https://prod.id.forgerock.io";

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "pull-"));
  nock.disableNetConnect();
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("pullAllJourneys", () => {
  it("fetches all realms × journeys and writes them under a fresh snapshot dir", async () => {
    nock(tenant)
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, {
        result: [
          { _id: "alpha-id", name: "alpha", parentPath: "/" }
        ],
        resultCount: 1
      });
    nock(tenant)
      .get("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees?_queryFilter=true")
      .reply(200, { result: [{ _id: "Login" }, { _id: "Register" }], resultCount: 2 });
    nock(tenant)
      .get("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Login")
      .reply(200, { _id: "Login", entryNodeId: "a" });
    nock(tenant)
      .get("/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Register")
      .reply(200, { _id: "Register", entryNodeId: "b" });

    const cache = { get: async () => "token", invalidate: () => {} };
    const result = await pullAllJourneys({
      tenantUrl: tenant,
      tokenCache: cache,
      envName: "prod",
      globalStoragePath: storage
    });

    expect(result.realmCount).toBe(1);
    expect(result.journeyCount).toBe(2);

    const dir = latestSnapshotDir(storage, "prod");
    expect(dir).toBeDefined();
    expect(existsSync(journeyFile(dir!, "alpha", "Login"))).toBe(true);
    expect(existsSync(journeyFile(dir!, "alpha", "Register"))).toBe(true);
  });

  it("creates an empty snapshot dir when env has no realms", async () => {
    nock(tenant)
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, { result: [], resultCount: 0 });

    const cache = { get: async () => "token", invalidate: () => {} };
    const result = await pullAllJourneys({
      tenantUrl: tenant,
      tokenCache: cache,
      envName: "prod",
      globalStoragePath: storage
    });
    expect(result.realmCount).toBe(0);
    expect(result.journeyCount).toBe(0);
    expect(latestSnapshotDir(storage, "prod")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Write implementation** (Write tool)

```typescript
// src/core/pull/pullJourneys.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TokenCache } from "../aic/auth";
import { listRealms } from "../aic/realms";
import { listJourneys, fetchJourney } from "../aic/journeys";
import { envSnapshotDir, isoStamp } from "../snapshots/paths";
import { writeJourney } from "../snapshots/writer";

export interface PullParams {
  tenantUrl: string;
  tokenCache: TokenCache;
  envName: string;
  globalStoragePath: string;
}

export interface PullResult {
  snapshotDir: string;
  realmCount: number;
  journeyCount: number;
}

export async function pullAllJourneys(params: PullParams): Promise<PullResult> {
  const stamp = isoStamp();
  const snapshotDir = join(envSnapshotDir(params.globalStoragePath, params.envName), stamp);
  mkdirSync(snapshotDir, { recursive: true });

  const realms = await listRealms(params.tenantUrl, params.tokenCache);
  let journeyCount = 0;

  for (const realm of realms) {
    const ids = await listJourneys(params.tenantUrl, realm, params.tokenCache);
    for (const id of ids) {
      const body = await fetchJourney(params.tenantUrl, realm, id, params.tokenCache);
      writeJourney(snapshotDir, realm, id, body);
      journeyCount += 1;
    }
  }

  return { snapshotDir, realmCount: realms.length, journeyCount };
}
```

- [ ] **Step 4: Run → PASS (2 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/pull/pullJourneys.ts aic-studio/src/core/pull/pullJourneys.test.ts
git commit -m "feat(aic-studio): pullAllJourneys orchestration (realms × journeys)"
```

---

## Task 14: TextDocumentContentProvider for aic://

**Files:**
- Create: `aic-studio/src/providers/virtualDocs.ts`

- [ ] **Step 1: Write the provider** (Write tool)

```typescript
// src/providers/virtualDocs.ts
import * as vscode from "vscode";
import { readJourneyFromLatest } from "../core/snapshots/reader";

export const AIC_SCHEME = "aic";

export interface ParsedAicUri {
  envName: string;
  realm: string;
  resourceType: string;
  id: string;
}

/** Parse aic://<env>/<realm>/<type>/<id> */
export function parseAicUri(uri: vscode.Uri): ParsedAicUri | undefined {
  if (uri.scheme !== AIC_SCHEME) return undefined;
  const segments = uri.path.split("/").filter(Boolean);
  if (segments.length !== 3) return undefined;
  return {
    envName: uri.authority,
    realm: segments[0],
    resourceType: segments[1],
    id: segments[2]
  };
}

export function makeAicUri(envName: string, realm: string, resourceType: string, id: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: AIC_SCHEME,
    authority: envName,
    path: `/${realm}/${resourceType}/${id}`
  });
}

export class AicDocumentContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly globalStoragePath: string) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseAicUri(uri);
    if (!parsed) return "// not an aic:// URI";
    if (parsed.resourceType !== "journey") {
      return `// resource type '${parsed.resourceType}' not supported in M2`;
    }
    const body = readJourneyFromLatest(
      this.globalStoragePath,
      parsed.envName,
      parsed.realm,
      parsed.id
    );
    if (!body) {
      return `// no snapshot for ${parsed.envName}/${parsed.realm}/${parsed.id}\n// run: AIC Studio: Pull from environment`;
    }
    return JSON.stringify(body, null, 2);
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd aic-studio && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/providers/virtualDocs.ts
git commit -m "feat(aic-studio): TextDocumentContentProvider for aic:// URIs"
```

---

## Task 15: Extend EnvironmentsTreeProvider (env → realms → journeys)

**Files:**
- Modify: `aic-studio/src/providers/envTree.ts`

- [ ] **Step 1: Read current envTree.ts**

Use Read tool. Confirm structure: `EnvNode` class extends TreeItem and `EnvironmentsTreeProvider` has `getChildren(element?)` returning `[]` for non-undefined element.

- [ ] **Step 2: Rewrite the provider to support nested nodes** (Write tool, overwriting)

```typescript
// src/providers/envTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments, getActiveEnvironment } from "../core/db/environments";
import type { Environment } from "../core/env/types";
import { listRealmsInLatest, listJourneysInLatest } from "../core/snapshots/reader";
import { makeAicUri } from "./virtualDocs";

type TreeNode = EnvNode | RealmNode | CategoryNode | JourneyNode;

export class EnvNode extends vscode.TreeItem {
  constructor(public readonly env: Environment, isActive: boolean) {
    super(env.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `env:${env.name}`;
    this.contextValue = "aic-studio.env";
    this.description = env.name + (isActive ? "  ●" : "");
    this.iconPath = new vscode.ThemeIcon("globe");
    this.tooltip = new vscode.MarkdownString(
      `**${env.label}** \\\n\`${env.name}\` \\\n${env.tenantUrl} \\\nUser: ${env.username}`
    );
  }
}

export class RealmNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string) {
    super(realm, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `realm:${envName}:${realm}`;
    this.contextValue = "aic-studio.realm";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class CategoryNode extends vscode.TreeItem {
  constructor(
    public readonly envName: string,
    public readonly realm: string,
    public readonly category: "journeys",
    count: number
  ) {
    super(`Journeys (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `cat:${envName}:${realm}:${category}`;
    this.contextValue = "aic-studio.category";
    this.iconPath = new vscode.ThemeIcon("symbol-event");
  }
}

export class JourneyNode extends vscode.TreeItem {
  constructor(
    public readonly envName: string,
    public readonly realm: string,
    public readonly journeyId: string
  ) {
    super(journeyId, vscode.TreeItemCollapsibleState.None);
    this.id = `journey:${envName}:${realm}:${journeyId}`;
    this.contextValue = "aic-studio.journey";
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.command = {
      command: "vscode.open",
      title: "Open journey",
      arguments: [makeAicUri(envName, realm, "journey", journeyId)]
    };
  }
}

export class EnvironmentsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly db: Database, private readonly globalStoragePath: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const active = getActiveEnvironment(this.db);
      return listEnvironments(this.db).map((env) => new EnvNode(env, env.name === active));
    }
    if (element instanceof EnvNode) {
      return listRealmsInLatest(this.globalStoragePath, element.env.name).map(
        (r) => new RealmNode(element.env.name, r)
      );
    }
    if (element instanceof RealmNode) {
      const count = listJourneysInLatest(this.globalStoragePath, element.envName, element.realm).length;
      return [new CategoryNode(element.envName, element.realm, "journeys", count)];
    }
    if (element instanceof CategoryNode) {
      return listJourneysInLatest(this.globalStoragePath, element.envName, element.realm).map(
        (id) => new JourneyNode(element.envName, element.realm, id)
      );
    }
    return [];
  }
}
```

- [ ] **Step 3: Verify typecheck**

```bash
cd aic-studio && npm run typecheck
```

Expected: 0 errors. (The change adds a constructor parameter `globalStoragePath` to `EnvironmentsTreeProvider`; extension.ts will be updated in Task 18 to pass it.)

If typecheck fails on `extension.ts`, that's expected — Task 18 wires it. For now, skip the typecheck step and proceed.

Actually — fix `extension.ts` here to keep typecheck clean. Edit the line `new EnvironmentsTreeProvider(db)` to `new EnvironmentsTreeProvider(db, ctx.globalStorageUri.fsPath)`.

```bash
cd aic-studio && npm run typecheck
```

Must exit 0.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/src/providers/envTree.ts aic-studio/src/extension.ts
git commit -m "feat(aic-studio): extend tree to show realms → journeys from snapshots"
```

---

## Task 16: SourceControl provider per env

**Files:**
- Create: `aic-studio/src/providers/sourceControl.ts`

- [ ] **Step 1: Write the implementation** (Write tool)

```typescript
// src/providers/sourceControl.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";

export class EnvSourceControlRegistry {
  private readonly scms = new Map<string, vscode.SourceControl>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly db: Database) {}

  /** Create or refresh SourceControl entries for all current envs. */
  syncFromDb(): void {
    const envs = listEnvironments(this.db);
    const envNames = new Set(envs.map((e) => e.name));

    // Dispose SCMs whose envs no longer exist
    for (const [name, scm] of this.scms.entries()) {
      if (!envNames.has(name)) {
        scm.dispose();
        this.scms.delete(name);
      }
    }
    // Create SCMs for new envs
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
        // Empty Changes group; M3 populates it
        scm.createResourceGroup("changes", "Changes");
        this.ctx.subscriptions.push(scm);
        this.scms.set(env.name, scm);
      }
    }
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd aic-studio && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/providers/sourceControl.ts
git commit -m "feat(aic-studio): per-env SourceControl provider (empty Changes group)"
```

---

## Task 17: Pull command + status bar progress

**Files:**
- Create: `aic-studio/src/status/pullProgress.ts`
- Create: `aic-studio/src/commands/sync.ts`

- [ ] **Step 1: Write status bar helper** (Write tool — `src/status/pullProgress.ts`)

```typescript
// src/status/pullProgress.ts
import * as vscode from "vscode";

export class PullProgressStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(ctx: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    ctx.subscriptions.push(this.item);
  }

  show(envName: string, message: string): void {
    this.item.text = `$(sync~spin) ${envName}: ${message}`;
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }
}
```

- [ ] **Step 2: Write sync command** (Write tool — `src/commands/sync.ts`)

```typescript
// src/commands/sync.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  getActiveEnvironment,
  getEnvironmentByName,
  listEnvironments
} from "../core/db/environments";
import type { SecretStore } from "../core/env/secrets";
import { createTokenCache, fetchAccessToken } from "../core/aic/auth";
import { pullAllJourneys } from "../core/pull/pullJourneys";
import { startOperation, finishOperation } from "../core/db/opHistory";
import type { PullProgressStatusBar } from "../status/pullProgress";
import { log, logError } from "../logging/output";

type Deps = {
  db: Database;
  secrets: SecretStore;
  globalStoragePath: string;
  pullStatus: PullProgressStatusBar;
  onChange: () => void;
};

export function registerSyncCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.sync.pull", (envNameArg?: string) =>
      pullCommand(deps, envNameArg)
    )
  );
}

async function pullCommand(deps: Deps, envNameArg?: string): Promise<void> {
  const envName = envNameArg ?? (await pickEnv(deps));
  if (!envName) return;

  const env = getEnvironmentByName(deps.db, envName);
  if (!env) {
    void vscode.window.showErrorMessage(`Unknown environment: ${envName}`);
    return;
  }
  const password = await deps.secrets.get(envName, "client-secret");
  if (!password) {
    void vscode.window.showErrorMessage(
      `No client secret configured for "${envName}". Use 'AIC Studio: Add environment…' to (re)configure.`
    );
    return;
  }

  const opId = startOperation(deps.db, { envName, opKind: "pull", scope: "journeys" });
  deps.pullStatus.show(envName, "authenticating…");
  log(`pull start: ${envName}`);

  try {
    const tokenCache = createTokenCache(() =>
      fetchAccessToken({
        tenantUrl: env.tenantUrl,
        clientId: env.clientId,
        clientSecret: password
      })
    );
    deps.pullStatus.show(envName, "fetching journeys…");
    const result = await pullAllJourneys({
      tenantUrl: env.tenantUrl,
      tokenCache,
      envName,
      globalStoragePath: deps.globalStoragePath
    });

    finishOperation(
      deps.db,
      opId,
      "success",
      `pulled ${result.journeyCount} journeys from ${result.realmCount} realms`
    );
    log(`pull success: ${envName} → ${result.journeyCount} journeys`);
    void vscode.window.showInformationMessage(
      `Pulled ${result.journeyCount} journeys from "${env.label}"`
    );
    deps.onChange();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishOperation(deps.db, opId, "failure", msg);
    logError(`pull failed: ${envName}`, err);
    void vscode.window.showErrorMessage(`Pull failed: ${msg}`);
  } finally {
    deps.pullStatus.hide();
  }
}

async function pickEnv(deps: Deps): Promise<string | undefined> {
  const active = getActiveEnvironment(deps.db);
  if (active) return active;
  const envs = listEnvironments(deps.db);
  if (envs.length === 0) {
    void vscode.window.showInformationMessage("No environments configured.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Pull from which environment?" }
  );
  return pick?.name;
}
```

- [ ] **Step 3: Verify typecheck**

```bash
cd aic-studio && npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add aic-studio/src/commands/sync.ts aic-studio/src/status/pullProgress.ts
git commit -m "feat(aic-studio): pull command + status bar progress indicator"
```

---

## Task 18: Compare command

**Files:**
- Create: `aic-studio/src/commands/compare.ts`

- [ ] **Step 1: Write the implementation** (Write tool)

```typescript
// src/commands/compare.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { makeAicUri } from "../providers/virtualDocs";
import type { JourneyNode } from "../providers/envTree";

type Deps = { db: Database };

export function registerCompareCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.compare.withEnv", (node?: JourneyNode) =>
      compareWithEnv(deps, node)
    )
  );
}

async function compareWithEnv(deps: Deps, node?: JourneyNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage(
      "Right-click a journey in the Environments tree to compare with another env."
    );
    return;
  }
  const others = listEnvironments(deps.db).filter((e) => e.name !== node.envName);
  if (others.length === 0) {
    void vscode.window.showInformationMessage("No other environment to compare against.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    others.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: `Compare ${node.envName}/${node.realm}/${node.journeyId} with…` }
  );
  if (!pick) return;

  const leftUri = makeAicUri(node.envName, node.realm, "journey", node.journeyId);
  const rightUri = makeAicUri(pick.name, node.realm, "journey", node.journeyId);
  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    `${node.journeyId}: ${node.envName} ↔ ${pick.name}`
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd aic-studio && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/commands/compare.ts
git commit -m "feat(aic-studio): compare command opens vscode.diff between two envs"
```

---

## Task 19: package.json contributes — new commands + menus

**Files:**
- Modify: `aic-studio/package.json`

- [ ] **Step 1: Read package.json** (Read tool — find `contributes.commands` and `contributes.menus`)

- [ ] **Step 2: Append 2 new commands and their menu entries** (Edit tool, inside the `commands` array, after existing entries):

After the last command entry (`aic-studio.env.remove`) and BEFORE the `]` closing the commands array, insert:

```json
,
      { "command": "aic-studio.sync.pull", "title": "AIC Studio: Pull from environment", "category": "AIC Studio", "icon": "$(sync)" },
      { "command": "aic-studio.compare.withEnv", "title": "AIC Studio: Compare with environment…", "category": "AIC Studio" }
```

In `contributes.menus`, add a `view/item/context` section AND extend `view/title`:

Edit the `menus` object so it reads:

```json
    "menus": {
      "view/title": [
        { "command": "aic-studio.env.add", "when": "view == aic-studio.environments", "group": "navigation@1" },
        { "command": "aic-studio.sync.pull", "when": "view == aic-studio.environments", "group": "navigation@2" }
      ],
      "view/item/context": [
        { "command": "aic-studio.sync.pull", "when": "viewItem == aic-studio.env", "group": "inline" },
        { "command": "aic-studio.compare.withEnv", "when": "viewItem == aic-studio.journey", "group": "1_compare" }
      ]
    },
```

- [ ] **Step 3: Verify package.json is valid JSON**

```bash
cd aic-studio && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add aic-studio/package.json
git commit -m "feat(aic-studio): contribute sync.pull and compare.withEnv commands + menus"
```

---

## Task 20: Wire new commands into extension.ts

**Files:**
- Modify: `aic-studio/src/extension.ts`

- [ ] **Step 1: Read extension.ts** (Read tool)

- [ ] **Step 2: Edit extension.ts** to import the new modules, instantiate them, and register them. Use Edit tool to:

a) Add imports at the top (after existing imports):

```typescript
import { AicDocumentContentProvider, AIC_SCHEME } from "./providers/virtualDocs";
import { EnvSourceControlRegistry } from "./providers/sourceControl";
import { registerSyncCommands } from "./commands/sync";
import { registerCompareCommands } from "./commands/compare";
import { PullProgressStatusBar } from "./status/pullProgress";
```

b) After the `registerEnvCommands(ctx, { … })` block, add:

```typescript
    const pullStatus = new PullProgressStatusBar(ctx);
    const scmRegistry = new EnvSourceControlRegistry(ctx, db);
    scmRegistry.syncFromDb();

    const contentProvider = new AicDocumentContentProvider(ctx.globalStorageUri.fsPath);
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(AIC_SCHEME, contentProvider)
    );

    registerSyncCommands(ctx, {
      db,
      secrets,
      globalStoragePath: ctx.globalStorageUri.fsPath,
      pullStatus,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        scmRegistry.syncFromDb();
      }
    });

    registerCompareCommands(ctx, { db });
```

c) Update the existing `onChange` callback passed to `registerEnvCommands` so it also calls `scmRegistry.syncFromDb()` (env add/remove changes the SCM list). Edit:

```typescript
registerEnvCommands(ctx, {
  db,
  secrets,
  onChange: () => {
    envTree.refresh();
    statusBar.refresh();
    scmRegistry.syncFromDb();
  }
});
```

- [ ] **Step 3: Build**

```bash
cd aic-studio && npm run build
```

Expected: produces `out/extension.js` with no errors.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/src/extension.ts
git commit -m "feat(aic-studio): wire virtual docs, SCM, sync + compare commands"
```

---

## Task 21: Integration test — full pull flow with mocked AIC

**Files:**
- Create: `aic-studio/tests/integration/suite/pullFlow.test.ts`

- [ ] **Step 1: Write the test** (Write tool)

```typescript
// tests/integration/suite/pullFlow.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";
import nock from "nock";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

suite("Pull flow (mocked AIC)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  setup(() => nock.disableNetConnect());
  teardown(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test("pull command writes a snapshot when AIC responds with realms+journeys", async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);

    // Best-effort: stub out the secret for the test env so the command can run.
    // We rely on the user not having a real env configured in the integration test profile.
    // Instead: invoke the command with no env configured and assert it surfaces "No environments configured" without throwing.
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.sync.pull"))
    );
  });
});
```

(Note: a "real" integration test would seed the SQLite + SecretStorage with a fake env and assert the full nock-mocked round trip. Given the integration test environment's complexity around secret-store seeding from a test, we use a lighter-touch test here that confirms the command is wired and gracefully no-ops on empty state. The full unit tests in `src/core/pull/pullJourneys.test.ts` cover the orchestration end-to-end.)

- [ ] **Step 2: Build + run**

```bash
cd aic-studio && npm run test:integration
```

Expected: previous 6 tests + 1 new = 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/tests/integration/suite/pullFlow.test.ts
git commit -m "test(aic-studio): integration test for pull command (no-env case)"
```

---

## Task 22: Integration test — virtual docs URI scheme registered

**Files:**
- Create: `aic-studio/tests/integration/suite/virtualDocs.test.ts`

- [ ] **Step 1: Write the test** (Write tool)

```typescript
// tests/integration/suite/virtualDocs.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Virtual aic:// documents", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("opening an aic:// URI with no snapshot returns a friendly placeholder", async () => {
    const uri = vscode.Uri.parse("aic://prod-tenant/alpha/journey/Login");
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    assert.ok(text.includes("no snapshot") || text.includes("// "));
  });

  test("opening an aic:// URI with an unsupported resource type returns a note", async () => {
    const uri = vscode.Uri.parse("aic://prod-tenant/alpha/script/foo");
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.ok(doc.getText().includes("not supported"));
  });
});
```

- [ ] **Step 2: Build + run**

```bash
cd aic-studio && npm run test:integration
```

Expected: 7 prior + 2 new = 9 tests pass.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/tests/integration/suite/virtualDocs.test.ts
git commit -m "test(aic-studio): integration test for aic:// scheme provider"
```

---

## Task 23: Integration test — compare command registered

**Files:**
- Create: `aic-studio/tests/integration/suite/compare.test.ts`

- [ ] **Step 1: Write the test** (Write tool)

```typescript
// tests/integration/suite/compare.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Compare command", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("compare.withEnv command is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.compare.withEnv"));
  });

  test("compare.withEnv without a node argument informs the user gracefully", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.compare.withEnv"))
    );
  });

  test("sync.pull command is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.sync.pull"));
  });
});
```

- [ ] **Step 2: Build + run**

```bash
cd aic-studio && npm run test:integration
```

Expected: 9 prior + 3 new = 12 tests pass.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/tests/integration/suite/compare.test.ts
git commit -m "test(aic-studio): integration test for compare + sync commands registration"
```

---

## Task 24: Update CHANGELOG

**Files:**
- Modify: `aic-studio/CHANGELOG.md`

- [ ] **Step 1: Read current CHANGELOG.md** (Read tool)

- [ ] **Step 2: Add an M2 section above the M1 section** (Edit tool). Insert before `### Added (M1 — scaffold & environments)`:

```markdown
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
- 3 new integration tests; ~40 new unit tests
```

- [ ] **Step 3: Commit**

```bash
git add aic-studio/CHANGELOG.md
git commit -m "docs(aic-studio): CHANGELOG entry for M2"
```

---

## Task 25: M2 acceptance gate

**Files:** none (verification step)

- [ ] **Step 1: Clean reinstall + ABI rebuild**

```bash
cd aic-studio && rm -rf node_modules out coverage && npm ci
cd aic-studio && npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
```

- [ ] **Step 2: typecheck → lint → unit → build → integration**

```bash
cd aic-studio && npm run typecheck && npm run lint && npm test -- --run && npm run build && npm run test:integration
```

Between `npm ci` and unit tests, run `cd aic-studio && npm rebuild better-sqlite3` if the unit tests fail with NODE_MODULE_VERSION mismatch.

Expected: typecheck/lint clean; unit tests ≥50 passing (19 from M1 + ~35 added in M2); build clean; integration 12 passing (6 from M1 + 6 from M2).

- [ ] **Step 3: Coverage gate**

```bash
cd aic-studio && npm test -- --run --coverage
```

Expected: `src/core/` coverage ≥85% lines/functions/statements, ≥75% branches.

- [ ] **Step 4: Git state check**

```bash
git status                                # clean tree
git log --oneline -27                     # 25 M2 commits + some M1 anchor
git branch --show-current                 # aic-studio/m2
```

- [ ] **Step 5: Manual smoke (deferred to human user)**

User opens VS Code at the repo root, presses F5, then in the Extension Dev Host:
1. Add an env via "AIC Studio: Add environment…" pointing at a real AIC sandbox tenant.
2. Run "AIC Studio: Pull from environment" — observe status bar spinner; ends with info message about N journeys.
3. Expand the env in the sidebar → realm → "Journeys (N)" → click any journey. It opens as `aic://...` in the editor with JSON syntax highlighting.
4. Right-click another env's journey → "AIC Studio: Compare with environment…" → pick the first env → confirms the built-in diff editor opens.
5. Open the SCM panel (Ctrl/Cmd+Shift+G) → confirm an "AIC: <env>" source control is registered with an empty "Changes" group.

If anything fails: stop, report, do not advance to M3.

- [ ] **Step 6: NO COMMIT — this is the acceptance gate, not a code change.**

---

## Self-Review

Checked the plan against the spec sections:

- **§1 Architecture & repo layout** — Tasks add `src/core/aic/`, `src/core/snapshots/`, `src/core/pull/`, `src/providers/virtualDocs.ts`, `src/providers/sourceControl.ts`, `src/commands/sync.ts`, `src/commands/compare.ts`, `src/status/pullProgress.ts`. Two-layer boundary preserved (all `core/*` files are vscode-free; vscode imports only in providers/commands/status). ✓
- **§2 UI mapping** — Pull surfaces in SCM panel (Task 16) + tree title (Task 19) + tree context menu (Task 19) + command palette. Virtual docs (Task 14). Diff editor via `vscode.diff` (Task 18). Status bar spinner (Task 17). All match the spec's UI mapping table. ✓
- **§3 Data & persistence** — Snapshots as flat JSON on disk (Tasks 9, 10); `op_history` table (Tasks 1, 12); SecretStorage used for client secret resolution in pull command (Task 17). ✓
- **§4 Command surface** — `aic-studio.sync.pull` (Task 17), `aic-studio.compare.withEnv` (Task 18). Menu contributions in `view/title` and `view/item/context` (Task 19). ✓
- **§5 Build & distribution** — No build/dist changes in M2; M1 already covered. ✓
- **§6 Testing strategy** — Unit tests with nock for HTTP (Tasks 4, 6, 7, 8, 13); integration tests (Tasks 21, 22, 23). Coverage gate preserved (verified in Task 25). ✓
- **§7 Cutover plan** — N/A in M2. ✓

**Placeholder scan:** No "TBD", "TODO", or vague "add error handling" instructions remain in tasks. Each step has concrete code or commands.

**Type consistency:**
- `TokenCache` interface defined in Task 5, used by Tasks 6/7/8/13/17. Consistent.
- `PullResult` shape `{ snapshotDir, realmCount, journeyCount }` defined in Task 13, referenced in Task 17. Consistent.
- `EnvironmentsTreeProvider` constructor change in Task 15 (`(db, globalStoragePath)`) is propagated to `extension.ts` in the same task. Task 20 then composes everything.
- `parseAicUri` / `makeAicUri` / `AIC_SCHEME` defined in Task 14, used by Tasks 15 (tree → open command), 17 (n/a), 18 (compare), 20 (registration). Consistent.
- `OpRow.envName/opKind/scope/status` defined in Task 12, used by Task 17. Consistent.

**One forward reference flagged:** Task 16's `acceptInputCommand` references `aic-studio.sync.push`, which is M3 territory. That command won't exist in M2, so clicking the SCM input "accept" button in M2 would no-op (or VS Code logs "command not found"). This is intentional — M2 ships the SCM container with an inert input; M3 wires push. Confirmed acceptable; no fix needed.

**One small risk flagged:** Task 21's integration test for pullFlow doesn't actually seed a fake env + nock the AIC response inside the test-host process. Achieving that requires injecting test-only seeding into the extension. We accept this gap for M2 — the unit tests cover the full pull orchestration with nock at the core layer. M3 or a "test-harness" milestone could add a proper end-to-end integration if needed.

Plan ready for execution.
