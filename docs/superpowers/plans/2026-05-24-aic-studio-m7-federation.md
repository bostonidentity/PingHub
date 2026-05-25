# AIC Studio M7 — Federation Webview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add federation configuration support to AIC Studio. Federation in AIC means SAML2 service providers, OIDC clients, social identity providers, etc. Each is a JSON document accessible via REST. This milestone adds:
- Pull federation configs alongside journeys (`/am/json/realms/<realm>/realm-config/federation/...`)
- Federation as a child node under each env's tree (alongside Journeys)
- A **Federation editor webview** for complex SAML2 / OIDC editing that's awkward as raw JSON

**Architecture:** Adds `src/core/aic/federation.ts` (list + fetch + put for SAML2 providers, OIDC clients, social IdPs). Snapshots written under `<snap>/<realm>/federation/<type>/<id>.json`. New `FederationEditorWebview` (React 19 bundled by esbuild as IIFE) for editing — communicates with extension host via `postMessage` bus. Uses the SCM-aware push flow from M3 (extends `pushPromotionTask` to handle non-journey types).

**Tech Stack:** Adds React 19 + @vscode/webview-ui-toolkit for webview UI. Rest reused from M3.

**Branch:** `aic-studio/m7` branched from M4-M6 (or M3 if M4-M6 not merged yet).

---

## File Structure

```
aic-studio/
  src/
    core/aic/
      federation.ts                              NEW — list/fetch/put SAML2, OIDC, social
      federation.test.ts                         NEW
      urls.ts                                    MODIFY — add federation endpoint builders
      urls.test.ts                               MODIFY
    core/snapshots/
      paths.ts                                   MODIFY — add federationFile(snapDir, realm, type, id)
      paths.test.ts                              MODIFY
      writer.ts                                  MODIFY — writeFederation()
      writer.test.ts                             MODIFY
      reader.ts                                  MODIFY — readFederationFromLatest + list helpers
      reader.test.ts                             MODIFY
    core/pull/
      pullFederation.ts                          NEW — pull all federation types for an env
      pullFederation.test.ts                     NEW
      pullJourneys.ts                            MODIFY — call pullFederation inside same orchestration (rename to pullAll)
      pullJourneys.test.ts                       MODIFY
    core/push/
      pushFederation.ts                          NEW — single-item federation push
      pushFederation.test.ts                     NEW
      pushPromotionTask.ts                       MODIFY — route 'federation/*' types through pushFederation
      pushPromotionTask.test.ts                  MODIFY
    providers/
      envTree.ts                                 MODIFY — add FederationNode under each realm
      virtualDocs.ts                             MODIFY — resolve aic://<env>/<realm>/federation/<type>/<id>
    webviews/host/
      bridge.ts                                  NEW — shared message-bus types (Zod schemas)
      federationHost.ts                          NEW — extension-side handler for federation webview
    webviews/ui/federation-editor/
      main.tsx                                   NEW — React entry
      App.tsx                                    NEW — root component
      SamlProviderForm.tsx                       NEW
      OidcClientForm.tsx                         NEW
      style.css                                  NEW
    commands/
      federation.ts                              NEW — open federation editor command
    extension.ts                                 MODIFY — wire federation
  package.json                                   MODIFY — add commands, add react + react-dom + @vscode/webview-ui-toolkit deps
  esbuild.config.mjs                             MODIFY — add federation webview UI bundle entry
  tests/integration/suite/
    federation.test.ts                           NEW
```

---

## Pre-Task Setup

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m7 -b aic-studio/m7 aic-studio/m3
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m7/aic-studio
npm install react@^19.2.4 react-dom@^19.2.4 @vscode/webview-ui-toolkit@^1.4.0 zod@^3.23.0
npm install --save-dev @types/react@^19 @types/react-dom@^19
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
```

(If M4-M6 has been merged to `development` by then, branch from `development` instead of `aic-studio/m3` so M4-M6 helpers are available.)

---

## Task 1: AIC federation URL builders

**Files:** Modify `aic-studio/src/core/aic/urls.ts` and `urls.test.ts`

- [ ] **Step 1: Append failing tests:**

```typescript

import { samlProvidersListUrl, samlProviderDetailUrl, oidcClientsListUrl, oidcClientDetailUrl } from "./urls";

describe("Federation URLs", () => {
  const base = "https://prod.id.forgerock.io";

  it("samlProvidersListUrl uses _queryFilter=true", () => {
    expect(samlProvidersListUrl(base, "alpha")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/federation/entityproviders/saml2?_queryFilter=true"
    );
  });

  it("samlProviderDetailUrl uses entity id", () => {
    expect(samlProviderDetailUrl(base, "alpha", "sp-acme")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/federation/entityproviders/saml2/sp-acme"
    );
  });

  it("oidcClientsListUrl points at realm-config oauth2 clients", () => {
    expect(oidcClientsListUrl(base, "alpha")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/agents/OAuth2Client?_queryFilter=true"
    );
  });

  it("oidcClientDetailUrl uses agent id", () => {
    expect(oidcClientDetailUrl(base, "alpha", "my-client")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/agents/OAuth2Client/my-client"
    );
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Append implementation** to `urls.ts`:

```typescript

export function samlProvidersListUrl(tenantUrl: string, realm: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/federation/entityproviders/saml2?_queryFilter=true`;
}
export function samlProviderDetailUrl(tenantUrl: string, realm: string, id: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/federation/entityproviders/saml2/${id}`;
}
export function oidcClientsListUrl(tenantUrl: string, realm: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/agents/OAuth2Client?_queryFilter=true`;
}
export function oidcClientDetailUrl(tenantUrl: string, realm: string, id: string): string {
  return `${trimSlash(tenantUrl)}/am/json/realms/root/realms/${realm}/realm-config/agents/OAuth2Client/${id}`;
}
```

- [ ] **Step 4: Run → PASS (9 tests in urls.test.ts: 5 prior + 4 new)**

- [ ] **Step 5: Commit**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m7
git add aic-studio/src/core/aic/urls.ts aic-studio/src/core/aic/urls.test.ts
git commit -m "feat(aic-studio): AIC federation endpoint URL builders"
```

---

## Task 2: federation.ts — list/fetch/put

**Files:** Create `aic-studio/src/core/aic/federation.ts` + test

- [ ] **Step 1: Tests:**

```typescript
// src/core/aic/federation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import {
  listSamlProviders, fetchSamlProvider, putSamlProvider,
  listOidcClients, fetchOidcClient, putOidcClient
} from "./federation";

const cache = { get: async () => "t", invalidate: () => {} };
const tenant = "https://prod.id.forgerock.io";

beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

describe("SAML2 providers", () => {
  it("listSamlProviders returns provider ids", async () => {
    nock(tenant).get(/entityproviders\/saml2\?_queryFilter=true/).reply(200, {
      result: [{ _id: "sp-acme" }, { _id: "idp-okta" }], resultCount: 2
    });
    expect(await listSamlProviders(tenant, "alpha", cache)).toEqual(["sp-acme", "idp-okta"]);
  });

  it("fetchSamlProvider returns full body", async () => {
    nock(tenant).get(/entityproviders\/saml2\/sp-acme$/).reply(200, { _id: "sp-acme", entityID: "acme.example.com" });
    const r = await fetchSamlProvider(tenant, "alpha", "sp-acme", cache);
    expect(r._id).toBe("sp-acme");
  });

  it("putSamlProvider PUTs body", async () => {
    nock(tenant).put(/entityproviders\/saml2\/sp-acme$/, { _id: "sp-acme", x: 1 }).reply(200, { _id: "sp-acme", _rev: "2" });
    const r = await putSamlProvider(tenant, "alpha", "sp-acme", { _id: "sp-acme", x: 1 }, cache);
    expect(r._rev).toBe("2");
  });
});

describe("OIDC clients", () => {
  it("listOidcClients returns client ids", async () => {
    nock(tenant).get(/agents\/OAuth2Client\?_queryFilter=true/).reply(200, {
      result: [{ _id: "client-a" }], resultCount: 1
    });
    expect(await listOidcClients(tenant, "alpha", cache)).toEqual(["client-a"]);
  });

  it("fetchOidcClient returns full body", async () => {
    nock(tenant).get(/agents\/OAuth2Client\/client-a$/).reply(200, { _id: "client-a", redirectionUris: ["x"] });
    const r = await fetchOidcClient(tenant, "alpha", "client-a", cache);
    expect(r._id).toBe("client-a");
  });

  it("putOidcClient PUTs body", async () => {
    nock(tenant).put(/agents\/OAuth2Client\/client-a$/, { _id: "client-a" }).reply(200, { _id: "client-a", _rev: "2" });
    const r = await putOidcClient(tenant, "alpha", "client-a", { _id: "client-a" }, cache);
    expect(r._rev).toBe("2");
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementation:**

```typescript
// src/core/aic/federation.ts
import type { TokenCache } from "./auth";
import { createAuthedClient } from "./client";
import {
  samlProvidersListUrl, samlProviderDetailUrl,
  oidcClientsListUrl, oidcClientDetailUrl
} from "./urls";

interface ListResponse {
  result: Array<{ _id: string }>;
  resultCount: number;
}

async function listIds(url: string, cache: TokenCache): Promise<string[]> {
  const client = createAuthedClient(cache);
  const res = await client.get<ListResponse>(url);
  return res.data.result.map((r) => r._id);
}

async function fetchBody(url: string, cache: TokenCache): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.get<Record<string, unknown>>(url);
  return res.data;
}

async function putBody(url: string, body: Record<string, unknown>, cache: TokenCache): Promise<Record<string, unknown>> {
  const client = createAuthedClient(cache);
  const res = await client.put<Record<string, unknown>>(url, body);
  return res.data;
}

export function listSamlProviders(tenantUrl: string, realm: string, cache: TokenCache): Promise<string[]> {
  return listIds(samlProvidersListUrl(tenantUrl, realm), cache);
}
export function fetchSamlProvider(tenantUrl: string, realm: string, id: string, cache: TokenCache): Promise<Record<string, unknown>> {
  return fetchBody(samlProviderDetailUrl(tenantUrl, realm, id), cache);
}
export function putSamlProvider(tenantUrl: string, realm: string, id: string, body: Record<string, unknown>, cache: TokenCache): Promise<Record<string, unknown>> {
  return putBody(samlProviderDetailUrl(tenantUrl, realm, id), body, cache);
}
export function listOidcClients(tenantUrl: string, realm: string, cache: TokenCache): Promise<string[]> {
  return listIds(oidcClientsListUrl(tenantUrl, realm), cache);
}
export function fetchOidcClient(tenantUrl: string, realm: string, id: string, cache: TokenCache): Promise<Record<string, unknown>> {
  return fetchBody(oidcClientDetailUrl(tenantUrl, realm, id), cache);
}
export function putOidcClient(tenantUrl: string, realm: string, id: string, body: Record<string, unknown>, cache: TokenCache): Promise<Record<string, unknown>> {
  return putBody(oidcClientDetailUrl(tenantUrl, realm, id), body, cache);
}
```

- [ ] **Step 4: Run → PASS (6 tests)**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/aic/federation.ts aic-studio/src/core/aic/federation.test.ts
git commit -m "feat(aic-studio): SAML2 + OIDC federation REST helpers"
```

---

## Task 3: Snapshot helpers for federation

**Files:** Modify `aic-studio/src/core/snapshots/paths.ts`, `writer.ts`, `reader.ts` + tests

- [ ] **Step 1: Append test in `paths.test.ts`:**

```typescript

import { federationFile } from "./paths";

it("federationFile is realm/federation/<type>/<id>.json", () => {
  expect(federationFile("/snap/2026-05-24T15-30-00Z", "alpha", "saml2", "sp-acme")).toBe(
    "/snap/2026-05-24T15-30-00Z/alpha/federation/saml2/sp-acme.json"
  );
});
```

- [ ] **Step 2: Append impl in `paths.ts`:**

```typescript

export function federationFile(snapshotDir: string, realm: string, type: string, id: string): string {
  return join(snapshotDir, realm, "federation", type, `${id}.json`);
}
```

- [ ] **Step 3: Append test in `writer.test.ts`:**

```typescript

import { writeFederation } from "./writer";
import { federationFile } from "./paths";

it("writeFederation writes JSON to realm/federation/<type>/<id>.json", () => {
  const snapDir = join(root, "2026-05-24T15-30-00Z");
  writeFederation(snapDir, "alpha", "saml2", "sp-acme", { _id: "sp-acme", x: 1 });
  expect(existsSync(federationFile(snapDir, "alpha", "saml2", "sp-acme"))).toBe(true);
});
```

- [ ] **Step 4: Append impl in `writer.ts`:**

```typescript
import { federationFile } from "./paths";

export function writeFederation(
  snapshotDir: string,
  realm: string,
  type: string,
  id: string,
  body: unknown
): void {
  const p = federationFile(snapshotDir, realm, type, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 5: Append test in `reader.test.ts`:**

```typescript

import { readFederationFromLatest, listFederationTypesInLatest, listFederationIdsInLatest } from "./reader";

it("readFederationFromLatest reads from latest snapshot", () => {
  const dir = join(root, "snapshots", "prod", "2026-05-24T15-30-00Z", "alpha", "federation", "saml2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sp-acme.json"), JSON.stringify({ _id: "sp-acme", entityID: "acme" }));
  expect(readFederationFromLatest(root, "prod", "alpha", "saml2", "sp-acme")).toEqual({ _id: "sp-acme", entityID: "acme" });
});

it("listFederationTypesInLatest returns directory names under realm/federation/", () => {
  mkdirSync(join(root, "snapshots", "prod", "2026-05-24T15-30-00Z", "alpha", "federation", "saml2"), { recursive: true });
  mkdirSync(join(root, "snapshots", "prod", "2026-05-24T15-30-00Z", "alpha", "federation", "oidc"), { recursive: true });
  expect(listFederationTypesInLatest(root, "prod", "alpha").sort()).toEqual(["oidc", "saml2"]);
});

it("listFederationIdsInLatest lists JSON files in type dir", () => {
  const d = join(root, "snapshots", "prod", "2026-05-24T15-30-00Z", "alpha", "federation", "saml2");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "sp-acme.json"), "{}");
  writeFileSync(join(d, "idp-okta.json"), "{}");
  expect(listFederationIdsInLatest(root, "prod", "alpha", "saml2").sort()).toEqual(["idp-okta", "sp-acme"]);
});
```

- [ ] **Step 6: Append impl in `reader.ts`:**

```typescript

import { federationFile } from "./paths";

export function readFederationFromLatest(
  globalStoragePath: string, envName: string, realm: string, type: string, id: string
): Record<string, unknown> | undefined {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return undefined;
  const file = federationFile(dir, realm, type, id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function listFederationTypesInLatest(globalStoragePath: string, envName: string, realm: string): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return [];
  const fedDir = join(dir, realm, "federation");
  if (!existsSync(fedDir)) return [];
  return readdirSync(fedDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

export function listFederationIdsInLatest(globalStoragePath: string, envName: string, realm: string, type: string): string[] {
  const dir = latestSnapshotDir(globalStoragePath, envName);
  if (!dir) return [];
  const d = join(dir, realm, "federation", type);
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.replace(/\.json$/, ""));
}
```

- [ ] **Step 7: Run all snapshot tests** → all pass.

- [ ] **Step 8: Commit**

```bash
git add aic-studio/src/core/snapshots/
git commit -m "feat(aic-studio): snapshot helpers for federation resources"
```

---

## Task 4: pullFederation orchestration

**Files:** Create `aic-studio/src/core/pull/pullFederation.ts` + test

- [ ] **Step 1: Tests:**

```typescript
// src/core/pull/pullFederation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullAllFederation } from "./pullFederation";
import { federationFile } from "../snapshots/paths";

let storage: string;
const tenant = "https://prod.id.forgerock.io";

beforeEach(() => { storage = mkdtempSync(join(tmpdir(), "pullf-")); nock.disableNetConnect(); });
afterEach(() => { rmSync(storage, { recursive: true, force: true }); nock.cleanAll(); nock.enableNetConnect(); });

describe("pullAllFederation", () => {
  it("pulls SAML2 + OIDC for given realms and writes them under fresh snapshot dir", async () => {
    nock(tenant)
      .get(/saml2\?_queryFilter=true/).reply(200, { result: [{ _id: "sp-acme" }], resultCount: 1 })
      .get(/saml2\/sp-acme$/).reply(200, { _id: "sp-acme", entityID: "acme" })
      .get(/OAuth2Client\?_queryFilter=true/).reply(200, { result: [{ _id: "client-a" }], resultCount: 1 })
      .get(/OAuth2Client\/client-a$/).reply(200, { _id: "client-a" });

    const cache = { get: async () => "t", invalidate: () => {} };
    const result = await pullAllFederation({
      tenantUrl: tenant,
      tokenCache: cache,
      envName: "prod",
      globalStoragePath: storage,
      realms: ["alpha"],
      snapshotDir: join(storage, "snapshots", "prod", "2026-05-24T15-30-00Z")
    });

    expect(result.itemCount).toBe(2);
    expect(existsSync(federationFile(result.snapshotDir!, "alpha", "saml2", "sp-acme"))).toBe(true);
    expect(existsSync(federationFile(result.snapshotDir!, "alpha", "OAuth2Client", "client-a"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementation:**

```typescript
// src/core/pull/pullFederation.ts
import type { TokenCache } from "../aic/auth";
import {
  listSamlProviders, fetchSamlProvider,
  listOidcClients, fetchOidcClient
} from "../aic/federation";
import { writeFederation } from "../snapshots/writer";

export interface PullFederationParams {
  tenantUrl: string;
  tokenCache: TokenCache;
  envName: string;
  globalStoragePath: string;
  realms: string[];
  snapshotDir: string;
}

export interface PullFederationResult {
  snapshotDir: string | null;
  itemCount: number;
}

export async function pullAllFederation(params: PullFederationParams): Promise<PullFederationResult> {
  let count = 0;
  for (const realm of params.realms) {
    const samlIds = await listSamlProviders(params.tenantUrl, realm, params.tokenCache);
    for (const id of samlIds) {
      const body = await fetchSamlProvider(params.tenantUrl, realm, id, params.tokenCache);
      writeFederation(params.snapshotDir, realm, "saml2", id, body);
      count++;
    }
    const oidcIds = await listOidcClients(params.tenantUrl, realm, params.tokenCache);
    for (const id of oidcIds) {
      const body = await fetchOidcClient(params.tenantUrl, realm, id, params.tokenCache);
      writeFederation(params.snapshotDir, realm, "OAuth2Client", id, body);
      count++;
    }
  }
  return { snapshotDir: params.snapshotDir, itemCount: count };
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/pull/pullFederation.ts aic-studio/src/core/pull/pullFederation.test.ts
git commit -m "feat(aic-studio): pullAllFederation orchestration"
```

---

## Task 5: pullJourneys → invoke pullFederation too

**Files:** Modify `aic-studio/src/core/pull/pullJourneys.ts` + test

- [ ] **Step 1: Append test** to `pullJourneys.test.ts` that asserts a federation pull also happens. (Mock both endpoints.) Test similar to existing but with extra nock interceptors for federation.

```typescript

import { existsSync as existsSync2 } from "node:fs";
import { federationFile } from "../snapshots/paths";

describe("pullAllJourneys with federation co-pull", () => {
  it("also pulls federation when included realm has SAML + OIDC", async () => {
    nock(tenant)
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, { result: [{ _id: "alpha-id", name: "alpha", parentPath: "/" }], resultCount: 1 })
      .get(/authenticationtrees\?_queryFilter=true/).reply(200, { result: [], resultCount: 0 })
      .get(/saml2\?_queryFilter=true/).reply(200, { result: [{ _id: "sp" }], resultCount: 1 })
      .get(/saml2\/sp$/).reply(200, { _id: "sp" })
      .get(/OAuth2Client\?_queryFilter=true/).reply(200, { result: [], resultCount: 0 });

    const cache = { get: async () => "t", invalidate: () => {} };
    const result = await pullAllJourneys({
      tenantUrl: tenant, tokenCache: cache, envName: "prod", globalStoragePath: storage
    });
    expect(existsSync2(federationFile(result.snapshotDir, "alpha", "saml2", "sp"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL** (pullJourneys doesn't pull federation yet)

- [ ] **Step 3: Modify `pullJourneys.ts`** to call `pullAllFederation` inside the same orchestration after journey loop:

```typescript
import { pullAllFederation } from "./pullFederation";

// inside pullAllJourneys, after the realm/journey loop and before the return:
await pullAllFederation({
  tenantUrl: params.tenantUrl,
  tokenCache: params.tokenCache,
  envName: params.envName,
  globalStoragePath: params.globalStoragePath,
  realms,
  snapshotDir
});
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/pull/pullJourneys.ts aic-studio/src/core/pull/pullJourneys.test.ts
git commit -m "feat(aic-studio): pull federation alongside journeys"
```

---

## Task 6: pushFederation core

**Files:** Create `aic-studio/src/core/push/pushFederation.ts` + test

- [ ] **Step 1: Tests:**

```typescript
// src/core/push/pushFederation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushFederationFromSnapshot } from "./pushFederation";

let storage: string;

beforeEach(() => { storage = mkdtempSync(join(tmpdir(), "pushf-")); nock.disableNetConnect(); });
afterEach(() => { rmSync(storage, { recursive: true, force: true }); nock.cleanAll(); nock.enableNetConnect(); });

function seed(envName: string, stamp: string, realm: string, type: string, id: string, body: unknown) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "federation", type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("pushFederationFromSnapshot", () => {
  it("PUTs SAML2 provider to target env", async () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", "saml2", "sp-acme", { _id: "sp-acme", x: 1 });
    nock("https://stage.id.forgerock.io").put(/saml2\/sp-acme$/).reply(200, { _id: "sp-acme", _rev: "2" });
    const cache = { get: async () => "t", invalidate: () => {} };
    const r = await pushFederationFromSnapshot({
      globalStoragePath: storage, sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
      realm: "alpha", type: "saml2", id: "sp-acme"
    });
    expect(r.ok).toBe(true);
  });

  it("throws on missing snapshot", async () => {
    const cache = { get: async () => "t", invalidate: () => {} };
    await expect(pushFederationFromSnapshot({
      globalStoragePath: storage, sourceEnvName: "prod",
      targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
      realm: "alpha", type: "saml2", id: "missing"
    })).rejects.toThrow(/no snapshot|not found/i);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementation:**

```typescript
// src/core/push/pushFederation.ts
import type { TokenCache } from "../aic/auth";
import { putSamlProvider, putOidcClient } from "../aic/federation";
import { readFederationFromLatest } from "../snapshots/reader";

export interface PushFederationParams {
  globalStoragePath: string;
  sourceEnvName: string;
  targetTenantUrl: string;
  targetTokenCache: TokenCache;
  realm: string;
  type: string;
  id: string;
}

export async function pushFederationFromSnapshot(params: PushFederationParams): Promise<{ ok: true }> {
  const body = readFederationFromLatest(
    params.globalStoragePath, params.sourceEnvName, params.realm, params.type, params.id
  );
  if (!body) throw new Error(`no snapshot found for ${params.sourceEnvName}/${params.realm}/federation/${params.type}/${params.id}`);
  if (params.type === "saml2") {
    await putSamlProvider(params.targetTenantUrl, params.realm, params.id, body, params.targetTokenCache);
  } else if (params.type === "OAuth2Client") {
    await putOidcClient(params.targetTenantUrl, params.realm, params.id, body, params.targetTokenCache);
  } else {
    throw new Error(`Unsupported federation type: ${params.type}`);
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/push/pushFederation.ts aic-studio/src/core/push/pushFederation.test.ts
git commit -m "feat(aic-studio): pushFederationFromSnapshot"
```

---

## Task 7: pushPromotionTask routes federation items

**Files:** Modify `aic-studio/src/core/push/pushPromotionTask.ts` + test

- [ ] **Step 1: Append test** for federation routing:

```typescript

it("routes federation items through pushFederationFromSnapshot", async () => {
  seed("prod", "2026-05-24T10-00-00Z", "alpha", "Login", { _id: "Login" });
  // also seed federation
  const fedDir = join(storage, "snapshots", "prod", "2026-05-24T10-00-00Z", "alpha", "federation", "saml2");
  mkdirSync(fedDir, { recursive: true });
  writeFileSync(join(fedDir, "sp.json"), JSON.stringify({ _id: "sp" }));
  nock("https://stage.id.forgerock.io")
    .put(/authenticationtrees\/Login$/).reply(200, { _id: "Login" })
    .put(/saml2\/sp$/).reply(200, { _id: "sp" });
  const cache = { get: async () => "t", invalidate: () => {} };
  const summary = await pushPromotionTask({
    globalStoragePath: storage, sourceEnvName: "prod",
    targetTenantUrl: "https://stage.id.forgerock.io", targetTokenCache: cache,
    items: [
      { realm: "alpha", resourceType: "journey", resourceId: "Login" },
      { realm: "alpha", resourceType: "federation/saml2", resourceId: "sp" }
    ]
  });
  expect(summary.successCount).toBe(2);
  expect(summary.skippedCount).toBe(0);
});
```

- [ ] **Step 2: Modify `pushPromotionTask.ts`** — change resourceType branching:

```typescript
import { pushFederationFromSnapshot } from "./pushFederation";

// in the loop:
if (item.resourceType === "journey") {
  // existing path
} else if (item.resourceType.startsWith("federation/")) {
  const type = item.resourceType.slice("federation/".length);
  try {
    await pushFederationFromSnapshot({
      globalStoragePath: params.globalStoragePath,
      sourceEnvName: params.sourceEnvName,
      targetTenantUrl: params.targetTenantUrl,
      targetTokenCache: params.targetTokenCache,
      realm: item.realm,
      type,
      id: item.resourceId
    });
    successCount += 1;
  } catch (err) {
    failures.push({ item, error: err instanceof Error ? err.message : String(err) });
  }
} else {
  skippedCount += 1;
}
```

- [ ] **Step 3: Update existing "skips non-journey" test** — the federation `resourceType` is no longer skipped. Adjust the test name or assertion to keep `script` (still unsupported) as the skipped case, and add the new federation success case.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/src/core/push/pushPromotionTask.ts aic-studio/src/core/push/pushPromotionTask.test.ts
git commit -m "feat(aic-studio): pushPromotionTask routes federation/saml2 + federation/OAuth2Client items"
```

---

## Task 8: virtualDocs supports federation URIs

**Files:** Modify `aic-studio/src/providers/virtualDocs.ts`

- [ ] **Step 1: Extend `provideTextDocumentContent`** to handle `aic://<env>/<realm>/federation/<type>/<id>`:

Actually, the current URI structure assumes `/<realm>/<type>/<id>` (3 segments). Federation needs 4 segments. Update `parseAicUri` to return either form, OR introduce a separate resourceType "federation" with sub-type encoded as `federation:saml2` etc.

Simpler approach: extend `parseAicUri` to support 4-segment paths where segment[1] is `federation` and segment[2] is the federation type:

```typescript
export interface ParsedAicUri {
  envName: string;
  realm: string;
  resourceType: string;
  id: string;
  federationType?: string;
}

export function parseAicUri(uri: vscode.Uri): ParsedAicUri | undefined {
  if (uri.scheme !== AIC_SCHEME) return undefined;
  const segments = uri.path.split("/").filter(Boolean);
  if (segments.length === 3) {
    return { envName: uri.authority, realm: segments[0], resourceType: segments[1], id: segments[2] };
  }
  if (segments.length === 4 && segments[1] === "federation") {
    return {
      envName: uri.authority,
      realm: segments[0],
      resourceType: "federation",
      federationType: segments[2],
      id: segments[3]
    };
  }
  return undefined;
}
```

- [ ] **Step 2: Update `provideTextDocumentContent`** to handle the federation case:

```typescript
    if (parsed.resourceType === "federation" && parsed.federationType) {
      const body = readFederationFromLatest(
        this.globalStoragePath, parsed.envName, parsed.realm, parsed.federationType, parsed.id
      );
      if (!body) return `// no snapshot for ${parsed.envName}/${parsed.realm}/federation/${parsed.federationType}/${parsed.id}`;
      return JSON.stringify(body, null, 2);
    }
```

- [ ] **Step 3: Add `makeAicFederationUri` helper:**

```typescript
export function makeAicFederationUri(envName: string, realm: string, type: string, id: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: AIC_SCHEME,
    authority: envName,
    path: `/${realm}/federation/${type}/${id}`
  });
}
```

- [ ] **Step 4: typecheck**

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/providers/virtualDocs.ts
git commit -m "feat(aic-studio): virtualDocs support aic://env/realm/federation/type/id"
```

---

## Task 9: envTree adds Federation nodes

**Files:** Modify `aic-studio/src/providers/envTree.ts`

- [ ] **Step 1: Add FederationCategoryNode + FederationTypeNode + FederationItemNode** alongside the existing journey nodes. Update `getChildren` to also list federation under each RealmNode:

```typescript
// New nodes near existing JourneyNode
export class FederationCategoryNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string, count: number) {
    super(`Federation (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `fed-cat:${envName}:${realm}`;
    this.contextValue = "aic-studio.federationCategory";
    this.iconPath = new vscode.ThemeIcon("link");
  }
}
export class FederationTypeNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string, public readonly type: string, count: number) {
    super(`${type} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `fed-type:${envName}:${realm}:${type}`;
    this.contextValue = "aic-studio.federationType";
    this.iconPath = new vscode.ThemeIcon("symbol-class");
  }
}
export class FederationItemNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string, public readonly fedType: string, public readonly id: string) {
    super(id, vscode.TreeItemCollapsibleState.None);
    this.id = `fed-item:${envName}:${realm}:${fedType}:${id}`;
    this.contextValue = "aic-studio.federationItem";
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [makeAicFederationUri(envName, realm, fedType, id)]
    };
  }
}
```

(Import `makeAicFederationUri`, `listFederationTypesInLatest`, `listFederationIdsInLatest`.)

- [ ] **Step 2: Extend `getChildren`** to:
- After RealmNode → return `[CategoryNode(journeys), FederationCategoryNode]`
- For FederationCategoryNode → return FederationTypeNodes
- For FederationTypeNode → return FederationItemNodes

- [ ] **Step 3: typecheck**

- [ ] **Step 4: Commit**

```bash
git add aic-studio/src/providers/envTree.ts
git commit -m "feat(aic-studio): tree shows Federation under each realm"
```

---

## Task 10-15: Federation editor webview

Webview implementation is substantial. Tasks 10-15 cover:

- **Task 10:** Add react/react-dom/@vscode/webview-ui-toolkit deps; update package.json + esbuild config with federation webview entry point.
- **Task 11:** Bridge module — Zod-typed message schemas (`OpenRequest`, `LoadResponse`, `SaveRequest`, `SaveResponse`). Tests with vitest.
- **Task 12:** Extension-side host (`webviews/host/federationHost.ts`) — opens WebviewPanel, loads HTML scaffold, handles messages (load from snapshot, save → push to env).
- **Task 13:** React UI scaffold (`webviews/ui/federation-editor/main.tsx`, `App.tsx`) — renders SAML2 form for `saml2` type and OIDC form for `OAuth2Client` type. Uses `@vscode/webview-ui-toolkit` components.
- **Task 14:** Federation open command (`aic-studio.federation.openEditor`) wires the webview from a FederationItemNode.
- **Task 15:** Integration test for federation editor command registration.

Each task follows the M1-M3 patterns (Write code → typecheck → commit). Full code for each task TBD during execution; the file structure and ordering above is the spec contract.

[Plan continues with full task content during execution. The spec for each task above gives the contract — implementer should follow the same TDD + commit + report cycle as M1-M3.]

---

## Task 16: package.json contributes for federation

Add commands:
- `aic-studio.federation.openEditor`
- (others as needed for context menus)

Menus: `view/item/context` entries for FederationItemNode → open editor; FederationItemNode → addToTask; FederationItemNode → push.

- [ ] Commit

```bash
git commit -m "feat(aic-studio): contribute federation commands + menus"
```

---

## Task 17: Wire federation into extension.ts

Register the federation editor command + virtualDocs provider already handles federation URIs (Task 8). Build verifies.

- [ ] Commit

```bash
git commit -m "feat(aic-studio): wire federation editor into activation"
```

---

## Task 18: Integration test — federation command surface

```typescript
// tests/integration/suite/federation.test.ts
suite("Federation", () => {
  test("federation.openEditor is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.federation.openEditor"));
  });
});
```

Add to esbuild entry points. Run integration tests.

- [ ] Commit

```bash
git commit -m "test(aic-studio): federation integration test"
```

---

## Task 19: CHANGELOG + acceptance gate

CHANGELOG entry for M7 above M4-M6 section. Acceptance gate same shape as M3.

---

## Self-Review

**Spec coverage:** §2 Federation as dedicated Webview (Task 12–15) + tree integration (Task 9). §3 snapshots include federation under each env (Tasks 3, 4). §4 federation.openEditor command. §6 unit + integration tests throughout.

**Placeholder scan:** Tasks 10–15 deliberately reference the M1-M3 patterns rather than reproducing all webview boilerplate. The implementer should write each task following the same Write → typecheck → commit cycle. If specific code is needed, the implementer should ask the controller for the React/webview specifics rather than guessing.

**Note:** This plan is shorter than M1-M3 because Tasks 10-15 (webview) are described at a higher level. The webview implementation has well-known patterns (esbuild IIFE bundle, postMessage bridge with Zod schemas, React 19 hooks) that will be filled in during execution. If the implementer can't proceed without more detail, they should escalate as BLOCKED to the controller for a Tasks 10-15 detail plan.

Plan ready for execution.
