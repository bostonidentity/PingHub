# Managed Object "Find Usage" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Find Usage" capability to the browse tab's Managed Object view that finds every reference to a managed object *type* (e.g., `alpha_user`) across the locally-cached environment config — journeys, the script library, custom-endpoint scripts, IGA workflows, sync mappings, hooks, schedulers, and other artifacts.

**Architecture:** Mirror the existing `script-usage` analyze pattern. New `GET /api/analyze/managed-object-usage` route walks the env config tree, regex-matches the literal `managed/<type>` across `.json` and `.js` files, and categorizes each hit by file-path prefix (single const map). A new client panel renders results grouped by category, mounted from a button next to the selected managed object type. No DB, no cache.

**Tech Stack:** Next.js 16.2.2 (NOTE: `aic-pipeline/AGENTS.md` warns this version has breaking changes — when in doubt, mirror the live pattern in `aic-pipeline/src/app/api/analyze/script-usage/route.ts`), TypeScript, sync `fs` (matches the codebase's existing analyze routes; the 5 MB-per-file cap bounds memory), Vitest for tests, React 19.2.4 with Tailwind for the panel.

**Spec:** `docs/superpowers/specs/2026-05-08-managed-object-find-usage-design.md`

---

## File Structure

**New files:**
- `aic-pipeline/src/lib/managed-object-usage.ts` — pure helpers: `categorizeFilePath`, `findNearestJsonFieldName`, `CATEGORY_TABLE` const, types.
- `aic-pipeline/src/lib/managed-object-usage.test.ts` — unit tests for the two helpers.
- `aic-pipeline/src/app/api/analyze/managed-object-usage/route.ts` — the new GET route.
- `aic-pipeline/tests/api/managed-object-usage.test.ts` — integration tests against a fixture env tree.
- `aic-pipeline/tests/fixtures/managed-object-usage/` — fixture env config tree (one file per category + a decoy).
- `aic-pipeline/src/app/data/browse/ManagedObjectUsagePanel.tsx` — client results panel component.
- `aic-pipeline/tests/components/ManagedObjectUsagePanel.test.tsx` — component test.

**Modified files:**
- `aic-pipeline/src/app/data/browse/BrowsePanel.tsx` — add the "Find Usage" button and mount the panel for the currently selected managed object type. Exact insertion point identified in Task 7 below.

---

## Task 1: Path-prefix categorizer (TDD)

**Files:**
- Create: `aic-pipeline/src/lib/managed-object-usage.ts`
- Test: `aic-pipeline/src/lib/managed-object-usage.test.ts`

This is a pure function: given a forward-slash-normalized path relative to the env config root, return one of the 14 category labels from §5 of the spec.

- [ ] **Step 1: Write the failing tests**

Create `aic-pipeline/src/lib/managed-object-usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { categorizeFilePath } from "./managed-object-usage";

describe("categorizeFilePath", () => {
  it.each([
    ["alpha/journeys/kyid_loginMain/kyid_loginMain.json", "journey"],
    ["realms/alpha/journeys/foo/foo.json", "journey"],
    ["alpha/scripts/scripts-content/AUTH/foo.js", "script-library"],
    ["alpha/scripts/scripts-config/abc-uuid.json", "script-library-config"],
    ["endpoints/loginprerequisite/loginprerequisite.json", "custom-endpoint"],
    ["endpoints/loginprerequisite/loginprerequisite.js", "custom-endpoint"],
    ["iga/workflows/foo/foo.json", "workflow"],
    ["iga/assignments/Internal-Med.json", "iga-assignment"],
    ["iga/forms/MyForm.json", "iga-form"],
    ["alpha/managed-objects/alpha_user/alpha_user.json", "managed-object-config"],
    ["alpha/managed-objects/alpha_user/alpha_user.onCreate.js", "managed-object-config"],
    ["sync/mappings/WidgetDataFix/WidgetDataFix.json", "sync-mapping"],
    ["schedules/job_x/job_x.json", "scheduler"],
    ["internal-roles/admin.json", "internal-role"],
    ["access-config/policy.json", "access-config"],
    ["agents/connector1/config.json", "connector-agent"],
    ["random/file.json", "other"],
    ["alpha/something-unknown/x.json", "other"],
    ["alpha/managed-objects/alpha_user/scripts/foo.js", "managed-object-config"],
  ])("%s -> %s", (relPath, expected) => {
    expect(categorizeFilePath(relPath)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run tests; confirm they fail**

```bash
cd aic-pipeline && npx vitest run src/lib/managed-object-usage.test.ts
```
Expected: failure with "Cannot find module './managed-object-usage'" or similar.

- [ ] **Step 3: Write the minimal implementation**

Create `aic-pipeline/src/lib/managed-object-usage.ts`:

```ts
export type Category =
  | "journey"
  | "script-library"
  | "script-library-config"
  | "custom-endpoint"
  | "workflow"
  | "iga-assignment"
  | "iga-form"
  | "managed-object-config"
  | "sync-mapping"
  | "scheduler"
  | "internal-role"
  | "access-config"
  | "connector-agent"
  | "other";

const CATEGORY_TABLE: { test: RegExp; category: Exclude<Category, "other"> }[] = [
  { test: /(?:^|\/)(?:[^/]+\/)?journeys\/.+\.json$/, category: "journey" },
  { test: /(?:^|\/)(?:[^/]+\/)?scripts\/scripts-content\/.+\.js$/, category: "script-library" },
  { test: /(?:^|\/)(?:[^/]+\/)?scripts\/scripts-config\/.+\.json$/, category: "script-library-config" },
  { test: /(?:^|\/)endpoints\/.+\.(?:json|js)$/, category: "custom-endpoint" },
  { test: /(?:^|\/)iga\/workflows\/.+\.json$/, category: "workflow" },
  { test: /(?:^|\/)iga\/assignments\/.+\.json$/, category: "iga-assignment" },
  { test: /(?:^|\/)iga\/forms\/.+\.json$/, category: "iga-form" },
  { test: /(?:^|\/)(?:[^/]+\/)?managed-objects\/.+\.(?:json|js)$/, category: "managed-object-config" },
  { test: /(?:^|\/)sync\/mappings\/.+\.json$/, category: "sync-mapping" },
  { test: /(?:^|\/)schedules\/.+\.json$/, category: "scheduler" },
  { test: /(?:^|\/)internal-roles\/.+\.json$/, category: "internal-role" },
  { test: /(?:^|\/)access-config\//, category: "access-config" },
  { test: /(?:^|\/)agents\//, category: "connector-agent" },
];

export function categorizeFilePath(relPath: string): Category {
  const normalized = relPath.replace(/\\/g, "/");
  for (const row of CATEGORY_TABLE) {
    if (row.test.test(normalized)) return row.category;
  }
  return "other";
}
```

- [ ] **Step 4: Run tests; confirm they pass**

```bash
cd aic-pipeline && npx vitest run src/lib/managed-object-usage.test.ts
```
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add aic-pipeline/src/lib/managed-object-usage.ts aic-pipeline/src/lib/managed-object-usage.test.ts
git commit -m "feat(analyze): add path-prefix categorizer for managed-object usage"
```

---

## Task 2: JSON nearest-field-name lookback (TDD)

**Files:**
- Modify: `aic-pipeline/src/lib/managed-object-usage.ts`
- Modify: `aic-pipeline/src/lib/managed-object-usage.test.ts`

Given a JSON file content and a byte offset within it, scan backward up to 4 KB to find the nearest `"<key>":` token whose value contains that offset. Returns the key name or `null`. Heuristic, not a parser — accepts that nested structures may occasionally yield the wrong key.

- [ ] **Step 1: Add failing tests**

Append to `aic-pipeline/src/lib/managed-object-usage.test.ts`:

```ts
import { findNearestJsonFieldName } from "./managed-object-usage";

describe("findNearestJsonFieldName", () => {
  it("finds a simple top-level field", () => {
    const src = '{ "identityResource": "managed/alpha_user" }';
    const offset = src.indexOf("managed/");
    expect(findNearestJsonFieldName(src, offset)).toBe("identityResource");
  });

  it("returns null when no preceding key exists", () => {
    const src = "managed/alpha_user appears as a bare token";
    const offset = src.indexOf("managed/");
    expect(findNearestJsonFieldName(src, offset)).toBeNull();
  });

  it("walks back through nested object structure", () => {
    const src = '{"outer": {"target": "managed/alpha_user"}}';
    const offset = src.indexOf("managed/");
    expect(findNearestJsonFieldName(src, offset)).toBe("target");
  });

  it("respects the 4 KB lookback cap", () => {
    const filler = " ".repeat(5000);
    const src = `{ "identityResource":${filler}"managed/alpha_user" }`;
    const offset = src.indexOf("managed/");
    expect(findNearestJsonFieldName(src, offset)).toBeNull();
  });

  it("handles arrays without an immediate key", () => {
    const src = '{ "items": [ "managed/alpha_user" ] }';
    const offset = src.indexOf("managed/");
    expect(findNearestJsonFieldName(src, offset)).toBe("items");
  });
});
```

- [ ] **Step 2: Run; confirm fail**

```bash
cd aic-pipeline && npx vitest run src/lib/managed-object-usage.test.ts
```
Expected: 5 new tests fail (`findNearestJsonFieldName` not exported).

- [ ] **Step 3: Implement**

Append to `aic-pipeline/src/lib/managed-object-usage.ts`:

```ts
const FIELD_LOOKBACK_BYTES = 4096;

export function findNearestJsonFieldName(src: string, offset: number): string | null {
  const start = Math.max(0, offset - FIELD_LOOKBACK_BYTES);
  const window = src.slice(start, offset);
  const keyRe = /"([^"\\\n]{1,128})"\s*:/g;
  let lastKey: string | null = null;
  for (const m of window.matchAll(keyRe)) {
    lastKey = m[1];
  }
  return lastKey;
}
```

This greedy "last key before offset within the lookback window" is the heuristic from §4.1 of the spec. Intentionally simple — false positives in deeply nested structures are accepted.

- [ ] **Step 4: Run; confirm all pass**

```bash
cd aic-pipeline && npx vitest run src/lib/managed-object-usage.test.ts
```
Expected: all categorizer + 5 lookback tests pass.

- [ ] **Step 5: Commit**

```bash
git add aic-pipeline/src/lib/managed-object-usage.ts aic-pipeline/src/lib/managed-object-usage.test.ts
git commit -m "feat(analyze): add JSON nearest-field lookback for managed-object usage"
```

---

## Task 3: Build fixture env tree

**Files:**
- Create: `aic-pipeline/tests/fixtures/managed-object-usage/env-root/...` (tree below)

This fixture is an in-repo synthetic env config tree used by Task 4 integration tests. Each file references `managed/alpha_user` once. A decoy file references `managed/alpha_user_extra` to verify the regex word boundary.

- [ ] **Step 1: Create the fixture tree**

Create the following files (all relative to `aic-pipeline/tests/fixtures/managed-object-usage/env-root/`):

`alpha/journeys/kyid_login/kyid_login.json`:
```json
{ "identityResource": "managed/alpha_user", "_id": "kyid_login" }
```

`alpha/scripts/scripts-content/AUTH/foo.js`:
```js
var u = openidm.read("managed/alpha_user/" + id);
```

`alpha/scripts/scripts-config/abc-uuid.json`:
```json
{ "name": "foo", "context": "AUTHENTICATION_TREE_DECISION_NODE", "default": "managed/alpha_user" }
```

`endpoints/loginprerequisite/loginprerequisite.json`:
```json
{ "type": "text/javascript", "file": "loginprerequisite.js", "ref": "managed/alpha_user" }
```

`endpoints/loginprerequisite/loginprerequisite.js`:
```js
getResponse = openidm.read("managed/alpha_user/" + id, ["*"]);
```

`iga/workflows/intern_med/intern_med.json`:
```json
{ "actor": { "value": "managed/alpha_user/d831523b-ae78-48dc-8102-bf054f34aa45" } }
```

`iga/assignments/admin.json`:
```json
{ "value": "managed/alpha_user/abc" }
```

`iga/forms/MyForm.json`:
```json
{ "fieldRef": "managed/alpha_user" }
```

`alpha/managed-objects/alpha_user/alpha_user.json`:
```json
{ "resourceCollection": "managed/alpha_user" }
```

`alpha/managed-objects/alpha_user/alpha_user.onCreate.js`:
```js
openidm.create("managed/alpha_user", null, payload);
```

`sync/mappings/WidgetFix/WidgetFix.json`:
```json
{ "target": "managed/alpha_user" }
```

`schedules/nightly/nightly.json`:
```json
{ "invokeContext": { "script": { "source": "openidm.query('managed/alpha_user', {})" } } }
```

`internal-roles/admin.json`:
```json
{ "privileges": [ { "path": "managed/alpha_user" } ] }
```

`access-config/policy.json`:
```json
{ "rule": "allow read on managed/alpha_user" }
```

`agents/connector1/config.json`:
```json
{ "endpoint": "managed/alpha_user" }
```

`alpha/managed-objects/alpha_other/alpha_other.json` (decoy — `_extra` suffix must NOT match `alpha_user`):
```json
{ "ref": "managed/alpha_user_extra" }
```

`misc/notes.json` (decoy that falls into category `other`):
```json
{ "comment": "see managed/alpha_user for details" }
```

- [ ] **Step 2: Verify fixture exists**

```bash
find aic-pipeline/tests/fixtures/managed-object-usage -type f | sort
```
Expected: 17 files listed.

- [ ] **Step 3: Commit**

```bash
git add aic-pipeline/tests/fixtures/managed-object-usage
git commit -m "test(analyze): add fixture env tree for managed-object usage tests"
```

---

## Task 4: API route — happy path (TDD)

**Files:**
- Create: `aic-pipeline/src/app/api/analyze/managed-object-usage/route.ts`
- Create: `aic-pipeline/tests/api/managed-object-usage.test.ts`

Implements the GET handler. Validates inputs, walks the env config tree, runs the regex via `String.prototype.matchAll`, captures field names for JSON hits, returns the structured response. Sync `fs` reads matching the existing `script-usage/route.ts` style.

- [ ] **Step 1: Write the integration tests**

Create `aic-pipeline/tests/api/managed-object-usage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { GET } from "@/app/api/analyze/managed-object-usage/route";

const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/managed-object-usage/env-root");

vi.mock("@/lib/fr-config", () => ({
  getConfigDir: (env: string) => (env === "test-env" ? FIXTURE_ROOT : null),
}));

function makeReq(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/analyze/managed-object-usage");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe("GET /api/analyze/managed-object-usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 when env is missing", async () => {
    const res = await GET(makeReq({ type: "alpha_user" }) as any);
    expect(res.status).toBe(400);
  });

  it("400 when type is missing", async () => {
    const res = await GET(makeReq({ env: "test-env" }) as any);
    expect(res.status).toBe(400);
  });

  it("400 when type fails the validation regex", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "bad type!" }) as any);
    expect(res.status).toBe(400);
  });

  it("404 when env config dir is missing", async () => {
    const res = await GET(makeReq({ env: "no-such-env", type: "alpha_user" }) as any);
    expect(res.status).toBe(404);
  });

  it("returns hits across all expected categories", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("alpha_user");
    expect(body.query).toBe("managed/alpha_user");
    expect(body.truncated).toBe(false);
    const cats = body.counts.byCategory;
    expect(cats.journey).toBe(1);
    expect(cats["script-library"]).toBe(1);
    expect(cats["script-library-config"]).toBe(1);
    expect(cats["custom-endpoint"]).toBe(2);
    expect(cats.workflow).toBe(1);
    expect(cats["iga-assignment"]).toBe(1);
    expect(cats["iga-form"]).toBe(1);
    expect(cats["managed-object-config"]).toBe(2);
    expect(cats["sync-mapping"]).toBe(1);
    expect(cats.scheduler).toBe(1);
    expect(cats["internal-role"]).toBe(1);
    expect(cats["access-config"]).toBe(1);
    expect(cats["connector-agent"]).toBe(1);
    expect(cats.other).toBe(1);
  });

  it("does NOT match alpha_user_extra (word-boundary lookahead)", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }) as any);
    const body = await res.json();
    const decoy = body.hits.find((h: any) =>
      h.filePath.includes("managed-objects/alpha_other/alpha_other.json")
    );
    expect(decoy).toBeUndefined();
  });

  it("captures fieldName for JSON hits", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }) as any);
    const body = await res.json();
    const journeyHit = body.hits.find((h: any) => h.category === "journey");
    expect(journeyHit.fieldName).toBe("identityResource");
    const mappingHit = body.hits.find((h: any) => h.category === "sync-mapping");
    expect(mappingHit.fieldName).toBe("target");
  });

  it("leaves fieldName null for .js hits", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }) as any);
    const body = await res.json();
    const jsHit = body.hits.find(
      (h: any) => h.category === "script-library" && h.filePath.endsWith(".js")
    );
    expect(jsHit.fieldName).toBeNull();
  });

  it("marks self-references when file lives under managed-objects/<type>/", async () => {
    const res = await GET(makeReq({ env: "test-env", type: "alpha_user" }) as any);
    const body = await res.json();
    const selfHits = body.hits.filter((h: any) => h.isSelfReference);
    expect(selfHits.length).toBe(2);
    for (const h of selfHits) {
      expect(h.filePath.includes("managed-objects/alpha_user/")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run; confirm fail**

```bash
cd aic-pipeline && npx vitest run tests/api/managed-object-usage.test.ts
```
Expected: import error (route file does not exist).

- [ ] **Step 3: Implement the route**

Create `aic-pipeline/src/app/api/analyze/managed-object-usage/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import {
  categorizeFilePath,
  findNearestJsonFieldName,
  type Category,
} from "@/lib/managed-object-usage";

const TYPE_RE = /^[A-Za-z0-9_-]+$/;
const MAX_FILES = 20_000;
const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
const MAX_HITS = 2_000;
const TIMEOUT_MS = 30_000;

type Hit = {
  category: Category;
  filePath: string;
  line: number;
  column: number;
  snippet: string;
  fieldName: string | null;
  realmRoot: string | null;
  isSelfReference: boolean;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function* walkFiles(rootDir: string): Generator<string> {
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.name === "node_modules") continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(fp);
      } else if (e.isFile()) {
        if (e.name.endsWith(".json") || e.name.endsWith(".js")) {
          yield fp;
        }
      }
    }
  }
}

function relPathFromRoot(rootDir: string, abs: string): string {
  return path.relative(rootDir, abs).replace(/\\/g, "/");
}

function detectRealmRoot(rel: string): string | null {
  const m = rel.match(/^(?:realms\/)?([^/]+)\//);
  if (!m) return null;
  const NON_REALM = new Set([
    "endpoints", "iga", "sync", "schedules", "internal-roles",
    "access-config", "agents", "misc",
  ]);
  if (NON_REALM.has(m[1])) return null;
  return m[1];
}

export async function GET(req: NextRequest) {
  const env = req.nextUrl.searchParams.get("env");
  const type = req.nextUrl.searchParams.get("type");

  if (!env) return NextResponse.json({ error: "env required" }, { status: 400 });
  if (!type) return NextResponse.json({ error: "type required" }, { status: 400 });
  if (!TYPE_RE.test(type)) return NextResponse.json({ error: "invalid type" }, { status: 400 });

  const configDir = getConfigDir(env);
  if (!configDir || !fs.existsSync(configDir)) {
    return NextResponse.json({ error: "Config dir not found" }, { status: 404 });
  }

  const query = `managed/${type}`;
  const matchRe = new RegExp(`\\bmanaged/${escapeRegExp(type)}(?=[/"'\\s,)\\]}]|$)`, "g");

  const t0 = Date.now();
  const hits: Hit[] = [];
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let errors = 0;
  let truncated = false;

  outer:
  for (const abs of walkFiles(configDir)) {
    if (files >= MAX_FILES || hits.length >= MAX_HITS) { truncated = true; break; }
    if (Date.now() - t0 > TIMEOUT_MS) { truncated = true; break; }

    files++;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      errors++;
      continue;
    }
    if (stat.size > MAX_BYTES_PER_FILE) { skipped++; continue; }
    bytes += stat.size;

    let src: string;
    try {
      src = fs.readFileSync(abs, "utf-8");
    } catch {
      errors++;
      continue;
    }

    const rel = relPathFromRoot(configDir, abs);
    const isJson = abs.endsWith(".json");
    const category = categorizeFilePath(rel);
    const realmRoot = detectRealmRoot(rel);
    const selfRefRe = new RegExp(`(?:^|/)managed-objects/${escapeRegExp(type)}/`);
    const isSelfReference = category === "managed-object-config" && selfRefRe.test(rel);

    for (const m of src.matchAll(matchRe)) {
      if (hits.length >= MAX_HITS) { truncated = true; break outer; }
      const idx = m.index ?? 0;
      const before = src.slice(0, idx);
      const line = (before.match(/\n/g)?.length ?? 0) + 1;
      const lastNl = before.lastIndexOf("\n");
      const column = idx - (lastNl + 1) + 1;
      const lineEnd = src.indexOf("\n", idx);
      const fullLine = src.slice(lastNl + 1, lineEnd === -1 ? src.length : lineEnd);
      const snippet = fullLine.length > 200 ? fullLine.slice(0, 200) + "…" : fullLine;
      const fieldName = isJson ? findNearestJsonFieldName(src, idx) : null;

      hits.push({
        category, filePath: rel, line, column, snippet,
        fieldName, realmRoot, isSelfReference,
      });
    }
  }

  const counts = hits.reduce<Record<Category, number>>((acc, h) => {
    acc[h.category] = (acc[h.category] ?? 0) + 1;
    return acc;
  }, {} as Record<Category, number>);

  console.log(`[managed-object-usage] env=${env} type=${type} files=${files} hits=${hits.length} ms=${Date.now() - t0} truncated=${truncated}`);

  return NextResponse.json({
    env,
    type,
    query,
    scanned: { files, bytes, ms: Date.now() - t0, skipped, errors },
    truncated,
    hits,
    counts: { byCategory: counts },
  });
}
```

- [ ] **Step 4: Run; confirm pass**

```bash
cd aic-pipeline && npx vitest run tests/api/managed-object-usage.test.ts
```
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add aic-pipeline/src/app/api/analyze/managed-object-usage/route.ts aic-pipeline/tests/api/managed-object-usage.test.ts
git commit -m "feat(analyze): add managed-object-usage API route"
```

---

## Task 5: Truncation behavior test

**Files:**
- Modify: `aic-pipeline/tests/api/managed-object-usage.test.ts`

Verify that hitting `MAX_HITS` sets `truncated: true` and stops scanning cleanly. We feed the route an env tree containing one file with > 2,000 occurrences.

- [ ] **Step 1: Add the test**

Append to `aic-pipeline/tests/api/managed-object-usage.test.ts`:

```ts
import fs from "fs";
import os from "os";

describe("truncation", () => {
  it("sets truncated=true and caps at MAX_HITS", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mou-"));
    const dir = path.join(tmpRoot, "alpha/scripts/scripts-content/AUTH");
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 2500; i++) {
      lines.push(`openidm.read("managed/alpha_user/${i}");`);
    }
    fs.writeFileSync(path.join(dir, "many.js"), lines.join("\n"));

    // Re-mock getConfigDir to point at the tmp tree for env "trunc-env".
    // Note: vi.mock is hoisted; here we use a runtime override pattern by
    // requiring the route after we set the mock.
    vi.resetModules();
    vi.doMock("@/lib/fr-config", () => ({
      getConfigDir: (e: string) => (e === "trunc-env" ? tmpRoot : null),
    }));
    const mod = await import("@/app/api/analyze/managed-object-usage/route");

    const res = await mod.GET(makeReq({ env: "trunc-env", type: "alpha_user" }) as any);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.hits.length).toBeLessThanOrEqual(2000);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.doUnmock("@/lib/fr-config");
    vi.resetModules();
  });
});
```

NOTE: vitest module-mock ordering can be finicky. If `vi.doMock` after import does not take effect, restructure the test by exporting a helper `_setConfigDirForTesting` from the route file and calling it directly. The principle stands: feed the route enough matches to exceed `MAX_HITS`; assert `truncated` and `hits.length`.

- [ ] **Step 2: Run; confirm pass**

```bash
cd aic-pipeline && npx vitest run tests/api/managed-object-usage.test.ts
```
Expected: all tests pass including truncation.

- [ ] **Step 3: Commit**

```bash
git add aic-pipeline/tests/api/managed-object-usage.test.ts
git commit -m "test(analyze): cover truncation in managed-object-usage route"
```

---

## Task 6: Client panel component (TDD)

**Files:**
- Create: `aic-pipeline/src/app/data/browse/ManagedObjectUsagePanel.tsx`
- Create: `aic-pipeline/tests/components/ManagedObjectUsagePanel.test.tsx`

The panel takes `{ env, type, onClose }`, fetches `/api/analyze/managed-object-usage`, and renders results grouped by category with collapsible sections.

- [ ] **Step 1: Write component tests**

Create `aic-pipeline/tests/components/ManagedObjectUsagePanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManagedObjectUsagePanel } from "@/app/data/browse/ManagedObjectUsagePanel";

const mockResponse = {
  env: "test-env",
  type: "alpha_user",
  query: "managed/alpha_user",
  scanned: { files: 1284, bytes: 1234567, ms: 200, skipped: 0, errors: 0 },
  truncated: false,
  counts: { byCategory: { journey: 1, "script-library": 1 } },
  hits: [
    {
      category: "journey",
      filePath: "alpha/journeys/kyid_login/kyid_login.json",
      line: 4, column: 24,
      snippet: '"identityResource": "managed/alpha_user",',
      fieldName: "identityResource",
      realmRoot: "alpha",
      isSelfReference: false,
    },
    {
      category: "script-library",
      filePath: "alpha/scripts/scripts-content/AUTH/foo.js",
      line: 1, column: 22,
      snippet: 'var u = openidm.read("managed/alpha_user/" + id);',
      fieldName: null,
      realmRoot: "alpha",
      isSelfReference: false,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(mockResponse) }) as any));
});
afterEach(() => vi.unstubAllGlobals());

describe("ManagedObjectUsagePanel", () => {
  it("renders header and per-category counts after fetch", async () => {
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/Find usage of "alpha_user"/)).toBeInTheDocument();
    expect(await screen.findByText(/Scanned 1,284 files/)).toBeInTheDocument();
    expect(screen.getByText(/Journey \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Script library \(1\)/)).toBeInTheDocument();
  });

  it("shows the field name for JSON hits and omits it for JS hits", async () => {
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/field: identityResource/)).toBeInTheDocument();
    expect(screen.getByText(/openidm.read\("managed\/alpha_user/)).toBeInTheDocument();
  });

  it("renders empty state when there are no hits", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ...mockResponse, hits: [], counts: { byCategory: {} } }),
    }) as any));
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/No usages found/)).toBeInTheDocument();
  });

  it("renders truncation banner when truncated=true", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ...mockResponse, truncated: true }),
    }) as any));
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={() => {}} />);
    expect(await screen.findByText(/Showing first 2,000 hits/)).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<ManagedObjectUsagePanel env="test-env" type="alpha_user" onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText(/close/i)).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run; confirm fail**

```bash
cd aic-pipeline && npx vitest run tests/components/ManagedObjectUsagePanel.test.tsx
```
Expected: import error.

- [ ] **Step 3: Implement the component**

Create `aic-pipeline/src/app/data/browse/ManagedObjectUsagePanel.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

type Category =
  | "journey" | "script-library" | "script-library-config"
  | "custom-endpoint" | "workflow" | "iga-assignment" | "iga-form"
  | "managed-object-config" | "sync-mapping" | "scheduler"
  | "internal-role" | "access-config" | "connector-agent" | "other";

type Hit = {
  category: Category; filePath: string; line: number; column: number;
  snippet: string; fieldName: string | null; realmRoot: string | null;
  isSelfReference: boolean;
};

type Response = {
  scanned: { files: number; bytes: number; ms: number; skipped: number; errors: number };
  truncated: boolean;
  hits: Hit[];
  counts: { byCategory: Partial<Record<Category, number>> };
};

const CATEGORY_LABEL: Record<Category, string> = {
  "journey": "Journey",
  "script-library": "Script library",
  "script-library-config": "Script library (config)",
  "custom-endpoint": "Custom endpoint",
  "workflow": "Workflow",
  "iga-assignment": "IGA assignment",
  "iga-form": "IGA form",
  "managed-object-config": "Managed-object config",
  "sync-mapping": "Sync mapping",
  "scheduler": "Scheduler",
  "internal-role": "Internal role",
  "access-config": "Access config",
  "connector-agent": "Connector / agent",
  "other": "Other",
};

const CATEGORY_ORDER: Category[] = [
  "journey", "script-library", "script-library-config",
  "custom-endpoint", "workflow", "iga-assignment", "iga-form",
  "managed-object-config", "sync-mapping", "scheduler",
  "internal-role", "access-config", "connector-agent", "other",
];

export function ManagedObjectUsagePanel({
  env, type, onClose,
}: { env: string; type: string; onClose: () => void }) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<Category>>(new Set(CATEGORY_ORDER.filter(c => c !== "other")));

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const params = new URLSearchParams({ env, type });
    fetch(`/api/analyze/managed-object-usage?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Response>;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [env, type]);

  const toggle = (c: Category) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  return (
    <div className="border border-violet-200 rounded bg-violet-50 p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-violet-900">Find usage of "{type}"</div>
        <button
          type="button"
          aria-label="close"
          className="text-violet-700 hover:text-violet-900"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {!data && !error && <p className="text-slate-500 italic">Searching…</p>}
      {error && <p className="text-red-600">Error: {error}</p>}
      {data && (
        <>
          <p className="text-xs text-slate-600 mb-2">
            Scanned {data.scanned.files.toLocaleString()} files · {data.hits.length} hits
          </p>
          {data.truncated && (
            <p className="text-xs text-amber-700 mb-2">
              Showing first 2,000 hits — additional results were not loaded.
            </p>
          )}
          {data.hits.length === 0 && (
            <p className="text-slate-500 italic">No usages found in this environment.</p>
          )}
          {CATEGORY_ORDER.map((cat) => {
            const count = data.counts.byCategory[cat] ?? 0;
            if (count === 0) return null;
            const isOpen = open.has(cat);
            return (
              <div key={cat} className="mb-2">
                <button
                  type="button"
                  onClick={() => toggle(cat)}
                  className="font-medium text-violet-800 hover:underline"
                >
                  {isOpen ? "▾" : "▸"} {CATEGORY_LABEL[cat]} ({count})
                </button>
                {isOpen && (
                  <ul className="mt-1 ml-4 space-y-1">
                    {data.hits.filter(h => h.category === cat).map((h, i) => (
                      <li key={i} className="text-xs">
                        <div className="text-violet-700 font-mono">{h.filePath}</div>
                        <div className="text-slate-500">
                          line {h.line}
                          {h.fieldName && <> · field: {h.fieldName}</>}
                          {h.isSelfReference && <span className="ml-1 px-1 bg-violet-200 rounded text-[10px]">self / hooks</span>}
                        </div>
                        <div className="font-mono text-slate-700 truncate">{h.snippet}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run; confirm pass**

```bash
cd aic-pipeline && npx vitest run tests/components/ManagedObjectUsagePanel.test.tsx
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add aic-pipeline/src/app/data/browse/ManagedObjectUsagePanel.tsx aic-pipeline/tests/components/ManagedObjectUsagePanel.test.tsx
git commit -m "feat(browse): add ManagedObjectUsagePanel component"
```

---

## Task 7: Wire the button into BrowsePanel

**Files:**
- Modify: `aic-pipeline/src/app/data/browse/BrowsePanel.tsx`

Add a "Find Usage" button next to the currently selected managed object type. Clicking it toggles the panel.

- [ ] **Step 1: Locate the selected-type header**

Read `aic-pipeline/src/app/data/browse/BrowsePanel.tsx` and identify:
- The state variable holding the currently-selected type (e.g., `selectedType`).
- The `env` value in scope.
- The DOM region that displays the selected type's header (where the panel and button should live).

Note the relevant line numbers. The next step depends on what you find.

- [ ] **Step 2: Add state and the button**

Inside `BrowsePanel`, add:

```tsx
const [usageOpen, setUsageOpen] = useState(false);
```

Place a button near the selected-type header (style mirrors `ScriptScopeFileRow` in `aic-pipeline/src/app/compare/DiffReport.tsx` lines 2094-2107):

```tsx
{selectedType && (
  <button
    type="button"
    onClick={() => setUsageOpen((v) => !v)}
    className={cn(
      "px-1.5 py-0.5 text-[10px] font-medium rounded border transition-colors",
      usageOpen
        ? "bg-violet-100 text-violet-700 border-violet-200"
        : "text-slate-500 border-slate-300 hover:text-violet-600 hover:bg-violet-50 hover:border-violet-200"
    )}
  >
    Find Usage
  </button>
)}
```

(Substitute the actual variable name found in Step 1 if different from `selectedType`.)

- [ ] **Step 3: Mount the panel**

Below the button (or wherever fits the existing layout):

```tsx
{usageOpen && selectedType && (
  <ManagedObjectUsagePanel
    env={env}
    type={selectedType}
    onClose={() => setUsageOpen(false)}
  />
)}
```

Add the import at the top of the file:
```tsx
import { ManagedObjectUsagePanel } from "./ManagedObjectUsagePanel";
```

- [ ] **Step 4: Type-check + tests**

```bash
cd aic-pipeline && npx tsc --noEmit && npx vitest run
```
Expected: no type errors; all tests still pass.

- [ ] **Step 5: Commit**

```bash
git add aic-pipeline/src/app/data/browse/BrowsePanel.tsx
git commit -m "feat(browse): wire Find Usage button for managed object types"
```

---

## Task 8: Manual browser verification

**Files:** none

Required by the system prompt for any UI change: start the dev server and exercise the feature.

- [ ] **Step 1: Start the dev server**

```bash
cd aic-pipeline && npm run dev
```
Expected: server starts on `http://localhost:3000`.

- [ ] **Step 2: Open the browse tab**

Navigate to the browse tab. Pick an env that has cached config (any env with a populated `config/` dir).

- [ ] **Step 3: Trigger Find Usage**

- Select a managed object type (e.g., `alpha_user`) in the left pane.
- Click the new "Find Usage" button.
- Verify: panel opens, fetches, and renders categorized results within a few seconds.

- [ ] **Step 4: Spot-check categories**

Confirm at least these categories appear with non-zero counts in a populated env:
- `Journey` — references in journey JSONs
- `Script library` — references in `scripts-content/**/*.js`
- `Custom endpoint` — references in `endpoints/**`
- `Sync mapping` — references in `sync/mappings/**`

- [ ] **Step 5: Spot-check edge cases**

- Click a category header to collapse/expand.
- Click ✕ to close the panel; confirm it closes.
- Pick a type with no usages (if available) and confirm the empty state renders.

- [ ] **Step 6: Stop the dev server**

`Ctrl+C` in the dev-server terminal.

- [ ] **Step 7: Note any issues**

If anything looks wrong, file follow-up tasks. Do not "fix forward" silently; loop back to the affected task(s).

No commit (no code change).

---

## Self-review

Spec → plan coverage:
- Goal (§1 spec): Tasks 4 + 6 + 7 deliver the route + UI.
- Non-goals (§2): no task implements them — correct.
- API route (§4): Tasks 1 (categorizer), 2 (field lookback), 4 (route + happy-path tests), 5 (truncation test).
- Limits (§4.2): hard-coded constants in Task 4; truncation tested in Task 5.
- Errors (§4.3): 400/404 cases covered in Task 4 tests.
- Logging (§4.5): Task 4 includes one `console.log` per request.
- Path map (§5): Task 1 implements + tests it.
- UI (§6): Task 6 component, Task 7 wires the button.
- Empty/partial states (§6.4): Task 6 tests cover empty and truncated cases.
- Testing (§7): all four test types from spec are present (mapper, lookback, integration with fixture + decoy, truncation).

Placeholder scan: no "TBD", no "implement later", no "similar to". Each step has the actual code or command. The vitest mock-ordering NOTE in Task 5 is a real implementation hint, not a placeholder.

Type consistency: `Category` is defined once in Task 1, re-imported by Task 4 (route) and re-declared identically in Task 6 (component, since the component must not import server modules). Same string union, same labels — kept in sync by inspection.

One implementation deviation from the spec is documented at the top: the spec proposed `fs.createReadStream`; the plan uses sync `fs.readFileSync`. Reason: matches every other analyze route in the codebase, and the 5 MB-per-file cap bounds memory at one file at a time.
