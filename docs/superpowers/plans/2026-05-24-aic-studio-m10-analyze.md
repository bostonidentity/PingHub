# AIC Studio M10 — Analyze (Find Usage) Webview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cross-reference search across snapshots — "where is this script referenced?", "which journeys use this SAML provider?", "what scripts call into each other?". The legacy `aic-pipeline/src/lib/managed-object-usage.ts` + `aic-pipeline/src/app/analyze/` provides the reference algorithm. M10 ports the core algorithm and adds a rich result webview.

**Architecture:** Pure-data analysis over the latest snapshot per env. Indexes references between journeys (node script callouts), SAML2 providers (referenced by which journey nodes), OIDC clients (used by which redirects/scripts), managed-object fields (used by which journeys/scripts). Results rendered in a Webview Panel with filterable/groupable table.

**Branch:** `aic-studio/m10` branched from `aic-studio/m9`.

---

## File Structure

```
aic-studio/
  src/
    core/analyze/
      index.ts                                   NEW — entry point: findUsage(env, target)
      index.test.ts                              NEW
      indexer.ts                                 NEW — builds reference graph from snapshot
      indexer.test.ts                            NEW (uses fixtures from aic-pipeline/tests/fixtures/managed-object-usage/)
      types.ts                                   NEW — Reference, UsageResult types
      types.test.ts                              NEW (Zod schemas if any)
      journeyRefs.ts                             NEW — walk journey nodes for script + provider refs
      journeyRefs.test.ts                        NEW
      scriptRefs.ts                              NEW — script source AST-lite (regex) for callsite extraction
      scriptRefs.test.ts                         NEW
    providers/
      envTree.ts                                 MODIFY — add "Find Usage" command on JourneyNode + future nodes
    commands/
      analyze.ts                                 NEW — open analyze webview command
    webviews/host/
      analyzeHost.ts                             NEW
    webviews/ui/analyze/
      main.tsx                                   NEW
      App.tsx                                    NEW — result table w/ grouping
      style.css                                  NEW
    extension.ts                                 MODIFY — wire analyze
  tests/fixtures/managed-object-usage/           PORTED from aic-pipeline/tests/fixtures/managed-object-usage/
  package.json                                   MODIFY — add commands
  esbuild.config.mjs                             MODIFY — analyze webview bundle entry
  tests/integration/suite/
    analyze.test.ts                              NEW
```

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m10 -b aic-studio/m10 aic-studio/m9
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m10/aic-studio
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
# Port fixtures:
cp -r /Users/ledeng/projects/deloitte/ky/PingHub/aic-pipeline/tests/fixtures/managed-object-usage /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m10/aic-studio/tests/fixtures/
```

---

## Task 1: Reference types

**File:** `aic-studio/src/core/analyze/types.ts` + test

```typescript
export type ResourceRef = {
  realm: string;
  resourceType: "journey" | "script" | "saml2" | "OAuth2Client";
  id: string;
};

export interface Reference {
  source: ResourceRef;
  target: ResourceRef;
  detail?: string; // e.g. "node abc123" for journey node citation
}

export interface UsageResult {
  target: ResourceRef;
  refs: Reference[];
}
```

Simple test that asserts type shapes (compile-time via `expectTypeOf`).

Commit `feat(aic-studio): analyze reference + usage types`.

---

## Task 2: Journey reference walker

**File:** `aic-studio/src/core/analyze/journeyRefs.ts` + test

Walks a journey's nodes (`nodes` map) and collects references to:
- Scripts (script-node `nodes[x].script` field)
- Other journeys (inner-tree-node `nodes[x].tree`)
- SAML providers (saml-node `nodes[x].metaDataUrl` or similar)
- OIDC clients (oidc-node `nodes[x].clientId`)

```typescript
export interface JourneyRefsParams {
  realm: string;
  journeyId: string;
  body: Record<string, unknown>;
}

export function extractRefs(p: JourneyRefsParams): Reference[];
```

Tests use the ported fixtures from `aic-pipeline/tests/fixtures/managed-object-usage/` (or a smaller dedicated journey-graph fixture). Assert specific known references appear in result.

Commit.

---

## Task 3: Script reference walker

**File:** `aic-studio/src/core/analyze/scriptRefs.ts` + test

Regex-based extraction of script-to-script imports and managed-object references:
- `require('script-id')` or `frJava.callFunction('id', …)`
- `openidm.read('managed/user/<id>')`
- `idRepo.getAttribute(…)`

Returns Reference[] keyed by realm+scriptId.

Tests with sample script bodies asserting specific extractions.

Commit.

---

## Task 4: Indexer (build full reference graph)

**File:** `aic-studio/src/core/analyze/indexer.ts` + test

Walks all journeys + scripts in the latest snapshot for an env. Calls `extractRefs` per journey, `extractScriptRefs` per script. Returns full `Reference[]` array.

```typescript
export function indexEnv(globalStoragePath: string, envName: string): Reference[];
```

Tests seed a small temp snapshot with 2 journeys + 1 script and assert the references found.

Commit.

---

## Task 5: findUsage entry point

**File:** `aic-studio/src/core/analyze/index.ts` + test

```typescript
export function findUsage(
  globalStoragePath: string,
  envName: string,
  target: ResourceRef
): UsageResult {
  const allRefs = indexEnv(globalStoragePath, envName);
  const refs = allRefs.filter((r) =>
    r.target.realm === target.realm &&
    r.target.resourceType === target.resourceType &&
    r.target.id === target.id
  );
  return { target, refs };
}
```

Tests: given a fixture env, finding usage of a known script returns the journeys that reference it.

Commit `feat(aic-studio): findUsage entry point (full reference index)`.

---

## Task 6: Analyze webview host + UI

**Files:** `webviews/host/analyzeHost.ts`, `webviews/ui/analyze/{main.tsx,App.tsx,style.css}`

- Host receives `OpenRequest{envName, target}` from extension, runs `findUsage`, posts `UsageResponse{result}` to UI.
- React UI renders a grouped table (group by source.resourceType, then source.id), with filter inputs (text search), and "Open" buttons that send `OpenReference{ref}` back to host. Host then runs `vscode.commands.executeCommand("vscode.open", makeAicUri(...))`.

Includes Zod schemas in `bridge.ts` for the new message types.

Commit `feat(aic-studio): analyze webview host + UI`.

---

## Task 7: Analyze command

**File:** `aic-studio/src/commands/analyze.ts`

- `aic-studio.analyze.findUsage` accepts a JourneyNode or FederationItemNode (after M7). Reads `target` from the node, opens or focuses the analyze webview, sends OpenRequest.

Commit.

---

## Task 8: package.json contributes + tree menu

Add `aic-studio.analyze.findUsage` command. Add to `view/item/context` for `aic-studio.journey` group `3_analyze` and `aic-studio.federationItem` group `3_analyze`.

Commit.

---

## Task 9: Wire analyze into extension.ts

Register analyze command + webview host. Build.

Commit.

---

## Task 10: Integration test

```typescript
suite("Analyze", () => {
  test("analyze.findUsage registered", …);
  test("analyze.findUsage without node informs user gracefully", …);
});
```

Add to esbuild. Run. Commit.

---

## Task 11: CHANGELOG + acceptance gate

CHANGELOG above M9. Acceptance gate same shape as M3.

---

## Self-Review

**Spec coverage:** §2 Analyze as webview ✓. §6 unit + integration tests ✓.

**Type consistency:** `Reference{source, target, detail?}` and `ResourceRef{realm, resourceType, id}` consistent everywhere.

**Notes on scope:**
- Reference extraction is heuristic, not AST-perfect — regex-based for scripts is acceptable; document limitations.
- The legacy `managed-object-usage.ts` has more sophisticated managed-object indexing — port what we can but flag any deviations as DONE_WITH_CONCERNS.
- Indexing is synchronous + in-memory; for large envs (>5000 scripts) we may need caching. Defer to M10.1.
- Webview must handle empty results gracefully ("No usages found").

Plan ready.
