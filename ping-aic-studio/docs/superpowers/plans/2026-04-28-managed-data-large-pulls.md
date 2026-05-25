# Large Managed-Data Pulls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pulls of large managed-object types (>200k records) fast and resumable by switching new pulls to single-file NDJSON storage, persisting pagination cookies, and adding a per-env page-size override — without breaking existing pulled snapshots.

**Architecture:** Format-detection rule in every reader (`fs.existsSync(typeDir + "/data.ndjson")`) lets new code coexist with legacy `{id}.json` snapshots. Pull runner writes one streaming NDJSON file per type plus a small `_offsets.json` for O(1) random-access reads, and persists the AIC `_pagedResultsCookie` plus byte-length after each page so a resumed run can truncate any half-written tail and continue. A new `interrupted` job status surfaces resume in the UI.

**Tech stack:** Next.js (App Router), TypeScript, React 19, Vitest. The repo's `aic-pipeline/AGENTS.md` warns that Next.js APIs may have breaking changes vs. training data — read `aic-pipeline/node_modules/next/dist/docs/` before touching Next.js APIs (route handlers, response streams). Tests run with `npx vitest run <path>` (single file) or `npm test` (full suite). All file paths below are relative to `aic-pipeline/` unless prefixed with `aic-pipeline/`.

**Spec:** `aic-pipeline/docs/superpowers/specs/2026-04-28-managed-data-large-pulls-design.md`

---

## File map

**New files:**
- `src/lib/data/ndjson-format.ts` — small format-detection helper + offset-index types.

**Modified files:**
- `src/lib/data/types.ts` — `JobStatus` adds `"interrupted"`; `PerTypeProgress` adds `cookie?`, `byteLength?`.
- `src/lib/fr-config-types.ts` — `Environment` adds `pageSize?: number`.
- `src/lib/data/job-registry.ts` — boot recovery marks running jobs `interrupted` (preserving state) instead of `failed`.
- `src/lib/data/pull-runner.ts` — NDJSON write loop, configurable page size, cookie persistence, resume entry point, raised retry budget, cookie-expiry handling.
- `src/lib/data/snapshot-fs.ts` — readers detect NDJSON format; new code paths for `loadCache`, `readRecord`, `listRecords` search fallback.
- `src/app/api/data/pull/route.ts` — looks up `Environment.pageSize`, passes it into `runPull`.
- `src/app/api/data/pull/jobs/[jobId]/resume/route.ts` — **new** route: POST resumes an interrupted job.
- `src/app/api/data/search/[env]/route.ts` — NDJSON streaming branch.
- `src/app/api/data/export/[env]/[type]/route.ts` — NDJSON streaming branch.
- `src/app/api/environments/[name]/route.ts` — accepts `pageSize` in PUT body.
- `src/app/data/pull/JobCard.tsx` — Resume button + `interrupted` status pill.
- `src/app/data/environments/EnvEditor.tsx` — Pull page size numeric input.
- `src/app/environments/EnvironmentsManager.tsx` — Pull page size in add wizard step 1.

**Test files:**
- `src/lib/data/pull-runner.test.ts` — update existing assertions (per-record → NDJSON files), add new tests (cookie persistence, resume after crash, dedupe on resume, page-size config, retry budget, cookie expiry).
- `src/lib/data/snapshot-fs.test.ts` — parameterize tests across legacy + NDJSON fixtures.
- `src/lib/data/job-registry.test.ts` — update boot-recovery test (`failed` → `interrupted`).
- `tests/api/data/lifecycle.test.ts` — update on-disk shape assertions; add interrupt+resume scenario.
- `src/lib/data/ndjson-format.test.ts` — **new** unit tests for the format-detection helper.

---

## Task 1: Add type fields for resume + per-env page size

**Files:**
- Modify: `src/lib/data/types.ts`
- Modify: `src/lib/fr-config-types.ts:45-52`

- [ ] **Step 1: Edit `src/lib/data/types.ts` — add `"interrupted"` to `JobStatus`.**

Replace the `JobStatus` union (lines 1–7) with:

```ts
export type JobStatus =
  | "queued"
  | "running"
  | "aborting"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";
```

- [ ] **Step 2: Add `cookie` and `byteLength` to `PerTypeProgress`.**

Replace the `PerTypeProgress` block (lines 9–15) with:

```ts
export type PerTypeProgress = {
  type: string;
  status: "pending" | "running" | "done" | "failed";
  fetched: number;
  total: number | null;
  error?: string;
  /** Last persisted _pagedResultsCookie. null = last page reached; undefined = no cookie persisted yet. */
  cookie?: string | null;
  /** Bytes written to data.ndjson when `cookie` was persisted. Used to truncate half-written tail on resume. */
  byteLength?: number;
};
```

- [ ] **Step 3: Add `pageSize` to `Environment`.**

In `src/lib/fr-config-types.ts`, replace the `Environment` interface (lines 45–52) with:

```ts
export interface Environment {
  name: string;
  label: string;
  color: "blue" | "yellow" | "red" | "green" | "purple" | "orange" | "teal" | "pink" | "indigo" | "gray";
  type?: EnvironmentType;
  /** Only meaningful when type === "controlled". Indicates this is the first env in the pipeline. */
  devEnvironment?: boolean;
  /** Per-env override for the AIC pagination page size used by managed-data pulls. Defaults to 5000 when unset. */
  pageSize?: number;
}
```

- [ ] **Step 4: Verify the project still typechecks.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add aic-pipeline/src/lib/data/types.ts aic-pipeline/src/lib/fr-config-types.ts
git commit -m "feat(data-pull): add interrupted status, cookie/byteLength progress, env pageSize"
```

---

## Task 2: NDJSON format-detection helper

**Files:**
- Create: `src/lib/data/ndjson-format.ts`
- Test: `src/lib/data/ndjson-format.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `aic-pipeline/src/lib/data/ndjson-format.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isNDJsonFormat, NDJSON_FILE, OFFSETS_FILE } from "./ndjson-format";

let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-fmt-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("isNDJsonFormat", () => {
  it("returns false when data.ndjson is absent", () => {
    expect(isNDJsonFormat(tmpDir)).toBe(false);
  });

  it("returns true when data.ndjson exists", () => {
    fs.writeFileSync(path.join(tmpDir, NDJSON_FILE), "");
    expect(isNDJsonFormat(tmpDir)).toBe(true);
  });

  it("returns false when only legacy {id}.json files exist", () => {
    fs.writeFileSync(path.join(tmpDir, "u1.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "_manifest.json"), "{}");
    expect(isNDJsonFormat(tmpDir)).toBe(false);
  });

  it("exports the conventional file names", () => {
    expect(NDJSON_FILE).toBe("data.ndjson");
    expect(OFFSETS_FILE).toBe("_offsets.json");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/ndjson-format.test.ts`
Expected: FAIL with "Failed to load url ./ndjson-format" (module doesn't exist yet).

- [ ] **Step 3: Implement the helper.**

Create `aic-pipeline/src/lib/data/ndjson-format.ts`:

```ts
import { existsSync } from "fs";
import path from "path";

export const NDJSON_FILE = "data.ndjson";
export const OFFSETS_FILE = "_offsets.json";

/** True when the type directory was pulled with the NDJSON storage format. */
export function isNDJsonFormat(typeDir: string): boolean {
  return existsSync(path.join(typeDir, NDJSON_FILE));
}

/** Map of record id → byte offset in data.ndjson where the record's line begins. */
export type Offsets = Record<string, number>;
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/ndjson-format.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add aic-pipeline/src/lib/data/ndjson-format.ts aic-pipeline/src/lib/data/ndjson-format.test.ts
git commit -m "feat(data-pull): add NDJSON format-detection helper"
```

---

## Task 3: Pull-runner writes NDJSON instead of per-record files

**Files:**
- Modify: `src/lib/data/pull-runner.ts`
- Modify: `src/lib/data/pull-runner.test.ts:67-72` (existing happy-path assertion)

- [ ] **Step 1: Update the existing happy-path test to expect the NDJSON shape.**

In `aic-pipeline/src/lib/data/pull-runner.test.ts`, replace lines 67–77 (the assertions block in the happy-path test) with:

```ts
    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    expect(fs.readdirSync(typeDir).sort()).toEqual([
      "_index.json", "_manifest.json", "_offsets.json", "_refs.json", "data.ndjson",
    ]);

    const ndjson = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8");
    const lines = ndjson.split("\n").filter((l) => l.length > 0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { _id: "u1", userName: "a" },
      { _id: "u2", userName: "b" },
      { _id: "u3", userName: "c" },
    ]);

    const offsets = JSON.parse(fs.readFileSync(path.join(typeDir, "_offsets.json"), "utf-8"));
    expect(Object.keys(offsets).sort()).toEqual(["u1", "u2", "u3"]);
    // Sanity-check one offset by seeking and reading the line.
    const fd = fs.openSync(path.join(typeDir, "data.ndjson"), "r");
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, offsets.u2);
    fs.closeSync(fd);
    const u2Line = buf.toString("utf-8").split("\n")[0];
    expect(JSON.parse(u2Line)).toEqual({ _id: "u2", userName: "b" });

    const manifest = JSON.parse(fs.readFileSync(path.join(typeDir, "_manifest.json"), "utf-8"));
    expect(manifest.count).toBe(3);

    const after = registry.getJob(job.id)!;
    expect(after.status).toBe("completed");
    expect(after.progress[0]).toMatchObject({ status: "done", fetched: 3 });
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "fetches paginated records"`
Expected: FAIL — current runner writes `u1.json`, `u2.json`, `u3.json`, no `data.ndjson` or `_offsets.json`.

- [ ] **Step 3: Update `pull-runner.ts` to write NDJSON.**

In `aic-pipeline/src/lib/data/pull-runner.ts`:

(a) Add imports at top:

```ts
import { NDJSON_FILE, OFFSETS_FILE, type Offsets } from "./ndjson-format";
```

(b) Replace the per-type initialization block (lines 159–168) with:

```ts
    const indexEntries: { id: string; f: Record<string, string> }[] = [];
    const refsIndex: Record<string, string[]> = {};
    const offsets: Offsets = {};

    const ndjsonPath = path.join(typePullingDir, NDJSON_FILE);
    const ndjsonStream = fs.createWriteStream(ndjsonPath, { flags: "a" });
    let bytesWritten = 0;

    let cookie: string | null = null;
    let total: number | null = await preflightCount(type, token);
    let fetched = 0;
    let typeFailed = false;
    if (total !== null) {
      registry.updateProgress(job.id, type, { fetched: 0, total });
    }
```

(c) Replace the per-record write block (currently around line 228–240) with:

```ts
          const items = data.result ?? [];
          for (const item of items) {
            if (signal.aborted) break outer;
            const id = typeof item._id === "string"
              ? item._id
              : typeof item.id === "string"
                ? item.id as string
                : String(fetched + 1);
            const line = JSON.stringify(item) + "\n";
            offsets[id] = bytesWritten;
            ndjsonStream.write(line);
            bytesWritten += Buffer.byteLength(line, "utf-8");
            indexEntries.push({ id, f: pickIndexFields(item) });
            const itemRefs = extractRefs(item);
            if (itemRefs.length > 0) refsIndex[id] = itemRefs;
            fetched++;
          }
```

(d) Just before the atomic-swap block (currently around line 286), close the NDJSON stream and write `_offsets.json`. Insert immediately after the `if (typeFailed) { ... continue; }` block, before the `try {` of atomic swap:

```ts
    // Close the NDJSON stream and flush before the atomic swap.
    await new Promise<void>((resolve, reject) => {
      ndjsonStream.end((err: NodeJS.ErrnoException | null | undefined) =>
        err ? reject(err) : resolve(),
      );
    });
```

(e) Inside the atomic-swap `try` block, add `_offsets.json` to the files written. Replace the existing `fs.writeFileSync` calls for `_manifest.json`, `_index.json`, `_refs.json` (currently lines 297–308) with:

```ts
      fs.writeFileSync(
        path.join(currentDir, "_manifest.json"),
        JSON.stringify({ type, pulledAt, count: fetched, jobId: job.id }, null, 2),
      );
      fs.writeFileSync(
        path.join(currentDir, "_index.json"),
        JSON.stringify(indexEntries),
      );
      fs.writeFileSync(
        path.join(currentDir, "_refs.json"),
        JSON.stringify(refsIndex),
      );
      fs.writeFileSync(
        path.join(currentDir, OFFSETS_FILE),
        JSON.stringify(offsets),
      );
```

(f) On the `if (typeFailed)` cleanup path (currently around line 280–284), close the stream before deleting the staging dir. Replace that block with:

```ts
    if (typeFailed) {
      anyFailed = true;
      ndjsonStream.destroy();
      fs.rmSync(typePullingDir, { recursive: true, force: true });
      continue;
    }
```

- [ ] **Step 4: Run the happy-path test to verify it now passes.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "fetches paginated records"`
Expected: PASS.

- [ ] **Step 5: Run the full pull-runner test file to catch regressions in other tests.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts`
Expected: all tests pass. The "preserves previous snapshot on failure" test seeds legacy `{id}.json` files in the *previous* snapshot directory; that's fine — the runner doesn't read those, only renames the dir.

- [ ] **Step 6: Commit.**

```bash
git add aic-pipeline/src/lib/data/pull-runner.ts aic-pipeline/src/lib/data/pull-runner.test.ts
git commit -m "feat(data-pull): write NDJSON + _offsets.json instead of per-record files"
```

---

## Task 4: Configurable page size from per-env config

**Files:**
- Modify: `src/lib/data/pull-runner.ts`
- Modify: `src/app/api/data/pull/route.ts`
- Modify: `src/lib/data/pull-runner.test.ts`

- [ ] **Step 1: Write a failing test for page-size configuration.**

In `aic-pipeline/src/lib/data/pull-runner.test.ts`, add a new describe block at the end of the file:

```ts
describe("runPull: page size", () => {
  it("uses opts.pageSize in the _pageSize query param", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{ _id: "u1" }], pagedResultsCookie: null, totalPagedResults: 1 }),
      } as Response;
    });

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
      pageSize: 7777,
    });

    const pageRequests = seenUrls.filter((u) => u.includes("_pageSize="));
    expect(pageRequests.length).toBeGreaterThan(0);
    for (const u of pageRequests) {
      expect(u).toContain("_pageSize=7777");
    }
  });

  it("defaults to 5000 when pageSize is not provided", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{ _id: "u1" }], pagedResultsCookie: null, totalPagedResults: 1 }),
      } as Response;
    });

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    const pageRequests = seenUrls.filter((u) => u.includes("_pageSize="));
    for (const u of pageRequests) {
      expect(u).toContain("_pageSize=5000");
    }
  });
});
```

- [ ] **Step 2: Run the new tests; verify they fail.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "page size"`
Expected: FAIL — current runner uses constant `1000`.

- [ ] **Step 3: Update `pull-runner.ts` to accept `pageSize`.**

In `aic-pipeline/src/lib/data/pull-runner.ts`:

(a) Replace `const PAGE_SIZE = 1000;` (line 8) with:

```ts
const DEFAULT_PAGE_SIZE = 5000;
```

(b) Add `pageSize?: number` to `RunPullOpts` (currently lines 70–86). The new interface:

```ts
export interface RunPullOpts {
  job: DataPullJob;
  registry: Registry;
  envsRoot: string;
  envVars: Record<string, string>;
  mintToken: (envVars: Record<string, string>) => Promise<string>;
  fetchFn?: typeof fetch;
  signal: AbortSignal;
  retryDelayMs?: number;
  /**
   * Optional preflight count source. Returns the total records expected for
   * a type, or null if unknown. Default implementation queries the tenant
   * with _countPolicy=EXACT. Tests typically pass a no-op to avoid having
   * to mock the preflight HTTP call.
   */
  preflightCount?: (type: string, token: string) => Promise<number | null>;
  /**
   * Page size for the `_pageSize` query param. Order of precedence at the
   * call site (route handler resolves these into a single number):
   *   1. Environment.pageSize from environments.json
   *   2. process.env.DATA_PULL_PAGE_SIZE
   *   3. DEFAULT_PAGE_SIZE (5000)
   */
  pageSize?: number;
}
```

(c) Inside `runPull`, near the top after destructuring `opts`, resolve the effective page size:

Replace the existing destructure block (lines 89–93):

```ts
  const {
    job, registry, envsRoot, envVars,
    mintToken, fetchFn = fetch, signal,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = opts;
```

with:

```ts
  const {
    job, registry, envsRoot, envVars,
    mintToken, fetchFn = fetch, signal,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    pageSize = DEFAULT_PAGE_SIZE,
  } = opts;
```

(d) In the page-fetch URL builder, replace `url.searchParams.set("_pageSize", String(PAGE_SIZE));` (line 176) with:

```ts
      url.searchParams.set("_pageSize", String(pageSize));
```

- [ ] **Step 4: Run the page-size tests; verify they pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "page size"`
Expected: 2 tests pass.

- [ ] **Step 5: Wire `pageSize` through the pull API route.**

In `aic-pipeline/src/app/api/data/pull/route.ts`:

(a) Add an import for `getEnvironments`:

```ts
import { getEnvironments } from "@/lib/fr-config";
```

(b) Inside `POST`, after fetching `envVars` (after line 36), add:

```ts
  const envMeta = getEnvironments().find((e) => e.name === env);
  const envPageSize = typeof envMeta?.pageSize === "number" && envMeta.pageSize > 0
    ? envMeta.pageSize
    : undefined;
  const globalPageSize = process.env.DATA_PULL_PAGE_SIZE
    ? parseInt(process.env.DATA_PULL_PAGE_SIZE, 10) || undefined
    : undefined;
  const pageSize = envPageSize ?? globalPageSize;
```

(c) Pass `pageSize` to `runPull` (replace the `void runPull({ ... })` call around line 61):

```ts
  void runPull({
    job,
    registry,
    envsRoot: ENVIRONMENTS_DIR,
    envVars,
    mintToken: (vars) => getAccessToken(vars),
    signal: ctl.signal,
    pageSize,
  }).finally(() => controllers.delete(job.id));
```

- [ ] **Step 6: Run the full pull-runner suite plus the lifecycle test.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts tests/api/data/lifecycle.test.ts`
Expected: pull-runner tests pass. The lifecycle test will fail on the on-disk shape assertion — that's fixed in Task 8. Skip that failure for now and do not commit it; just verify pull-runner suite is green.

- [ ] **Step 7: Commit.**

```bash
git add aic-pipeline/src/lib/data/pull-runner.ts aic-pipeline/src/lib/data/pull-runner.test.ts aic-pipeline/src/app/api/data/pull/route.ts
git commit -m "feat(data-pull): per-env page size override; default 5000"
```

---

## Task 5: Persist cookie + byteLength after each page

**Files:**
- Modify: `src/lib/data/pull-runner.ts`
- Modify: `src/lib/data/pull-runner.test.ts`

- [ ] **Step 1: Write a failing test for cookie + byteLength persistence.**

Append to `aic-pipeline/src/lib/data/pull-runner.test.ts`:

```ts
describe("runPull: cookie persistence", () => {
  it("persists cookie + byteLength on registry after each page", async () => {
    const fetchMock = mockFetchSequence([
      {
        status: 200, body: {
          result: [{ _id: "u1" }, { _id: "u2" }],
          pagedResultsCookie: "page2",
        }
      },
      {
        status: 200, body: {
          result: [{ _id: "u3" }],
          pagedResultsCookie: null,
        }
      },
    ]);

    const job = registry.startJob("uat", ["alpha_user"]);
    const updates: Array<{ cookie?: string | null; byteLength?: number; fetched?: number }> = [];
    const origUpdate = registry.updateProgress.bind(registry);
    registry.updateProgress = (id, type, patch) => {
      if ("cookie" in patch || "byteLength" in patch || "fetched" in patch) {
        updates.push({ ...patch });
      }
      origUpdate(id, type, patch);
    };

    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    // After page 1 we should have seen cookie="page2" with a positive byteLength.
    const afterPage1 = updates.find((u) => u.cookie === "page2");
    expect(afterPage1).toBeDefined();
    expect(afterPage1!.byteLength).toBeGreaterThan(0);

    // After the final page we should have seen cookie=null (last page reached).
    const afterFinal = updates.find((u) => u.cookie === null);
    expect(afterFinal).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test; verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "cookie persistence"`
Expected: FAIL — runner doesn't currently include `cookie` or `byteLength` in `updateProgress` calls.

- [ ] **Step 3: Update the runner to persist cookie + byteLength after each page.**

In `aic-pipeline/src/lib/data/pull-runner.ts`, find the post-page progress update (currently `registry.updateProgress(job.id, type, { fetched, total });` near line 247) and replace it with:

```ts
          // Drain the write stream so byteLength accurately reflects what's on disk.
          if (ndjsonStream.writableNeedDrain) {
            await new Promise<void>((resolve) => ndjsonStream.once("drain", resolve));
          }

          cookie = data.pagedResultsCookie ?? null;
          registry.updateProgress(job.id, type, {
            fetched,
            total,
            cookie,
            byteLength: bytesWritten,
          });
          success = true;
          break;
```

Remove the now-redundant `cookie = data.pagedResultsCookie ?? null;` and `registry.updateProgress(...)` lines that follow the original block.

- [ ] **Step 4: Run the cookie-persistence test; verify it passes.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "cookie persistence"`
Expected: PASS.

- [ ] **Step 5: Run the full pull-runner suite to ensure no regressions.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit.**

```bash
git add aic-pipeline/src/lib/data/pull-runner.ts aic-pipeline/src/lib/data/pull-runner.test.ts
git commit -m "feat(data-pull): persist pagedResultsCookie + byteLength after each page"
```

---

## Task 6: Job-registry boot recovery — `interrupted` instead of `failed`

**Files:**
- Modify: `src/lib/data/job-registry.ts:42-61`
- Modify: `src/lib/data/job-registry.test.ts:82-102`

- [ ] **Step 1: Write a failing test for the new boot behavior.**

In `aic-pipeline/src/lib/data/job-registry.test.ts`, replace the existing "stale cleanup on init" describe block (lines 82–102) with:

```ts
describe("job-registry: boot recovery", () => {
  it("marks running jobs as 'interrupted' on createRegistry, preserving per-type state", () => {
    const jobsDir = path.join(tmpDir, "uat", "managed-data", ".jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobsDir, "stale.json"),
      JSON.stringify({
        id: "stale",
        env: "uat",
        types: ["alpha_user"],
        startedAt: 1,
        status: "running",
        progress: [{
          type: "alpha_user",
          status: "running",
          fetched: 5,
          total: 10,
          cookie: "page2",
          byteLength: 1234,
        }],
      }),
    );
    const r2 = createRegistry(tmpDir);
    const stale = r2.getJob("stale");
    expect(stale?.status).toBe("interrupted");
    expect(stale?.fatalError).toBeUndefined();
    // Per-type state preserved so resume can pick up from the right place.
    expect(stale?.progress[0]).toMatchObject({
      status: "running",
      fetched: 5,
      cookie: "page2",
      byteLength: 1234,
    });
  });

  it("leaves already-terminal jobs untouched on boot", () => {
    const jobsDir = path.join(tmpDir, "uat", "managed-data", ".jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    for (const status of ["completed", "failed", "aborted"] as const) {
      fs.writeFileSync(
        path.join(jobsDir, `${status}.json`),
        JSON.stringify({
          id: status, env: "uat", types: ["alpha_user"],
          startedAt: 1, status,
          progress: [{ type: "alpha_user", status: "done", fetched: 10, total: 10 }],
        }),
      );
    }
    const r2 = createRegistry(tmpDir);
    expect(r2.getJob("completed")?.status).toBe("completed");
    expect(r2.getJob("failed")?.status).toBe("failed");
    expect(r2.getJob("aborted")?.status).toBe("aborted");
  });

  it("leaves already-interrupted jobs untouched on boot", () => {
    const jobsDir = path.join(tmpDir, "uat", "managed-data", ".jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobsDir, "i1.json"),
      JSON.stringify({
        id: "i1", env: "uat", types: ["alpha_user"],
        startedAt: 1, status: "interrupted",
        progress: [{ type: "alpha_user", status: "running", fetched: 5, total: 10, cookie: "c", byteLength: 100 }],
      }),
    );
    const r2 = createRegistry(tmpDir);
    expect(r2.getJob("i1")?.status).toBe("interrupted");
  });
});
```

- [ ] **Step 2: Run the test; verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/job-registry.test.ts -t "boot recovery"`
Expected: FAIL — current code marks running jobs `failed` with `fatalError: "server restart"`.

- [ ] **Step 3: Update `job-registry.ts` boot behavior.**

In `aic-pipeline/src/lib/data/job-registry.ts`, replace the `if (isActive(job)) { ... }` block (lines 51–56) with:

```ts
          if (isActive(job)) {
            // Preserve per-type cookie + byteLength + fetched so a Resume
            // (Task 9) can pick up exactly where the dead process left off.
            // Old behavior marked these `failed` with fatalError="server restart";
            // we now mark them `interrupted` instead.
            job.status = "interrupted";
            writeJobFile(envsRoot, job);
          }
```

- [ ] **Step 4: Run the boot-recovery tests; verify they pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/job-registry.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Update `isActive` so an interrupted job does not block a fresh start.**

The existing `isActive` is `!TERMINAL.includes(j.status)` and `TERMINAL = ["completed", "failed", "aborted"]`. An interrupted job is still "active" by that definition — which we want, because clicking Start while one is interrupted should still 409 (the user has to either Resume it or abort it first). No change needed; just confirm by re-reading lines 6 and 34 of `job-registry.ts`.

- [ ] **Step 6: Commit.**

```bash
git add aic-pipeline/src/lib/data/job-registry.ts aic-pipeline/src/lib/data/job-registry.test.ts
git commit -m "feat(data-pull): boot recovery marks running jobs interrupted, preserves cookie state"
```

---

## Task 7: Resume entry point in pull-runner

**Files:**
- Modify: `src/lib/data/pull-runner.ts`
- Modify: `src/lib/data/pull-runner.test.ts`

- [ ] **Step 1: Write a failing test for clean resume.**

Append to `aic-pipeline/src/lib/data/pull-runner.test.ts`:

```ts
describe("runPull: resume from cookie", () => {
  it("truncates half-written tail, rebuilds in-memory state, and continues from the persisted cookie", async () => {
    // Pre-state: a previous run wrote 2 pages + a half-written third record,
    // then crashed before the third record's offset was persisted.
    const typeStagingDir = path.join(tmpDir, "uat", "managed-data");
    const job = registry.startJob("uat", ["alpha_user"]);
    const pullingDir = path.join(typeStagingDir, `.pulling-${job.id}`, "alpha_user");
    fs.mkdirSync(pullingDir, { recursive: true });

    // Page 1: u1, u2. Page 2: u3, u4. Half-line: '{"_id":"u5...'.
    const page1 = `${JSON.stringify({ _id: "u1" })}\n${JSON.stringify({ _id: "u2" })}\n`;
    const page2 = `${JSON.stringify({ _id: "u3" })}\n${JSON.stringify({ _id: "u4" })}\n`;
    const halfLine = `{"_id":"u5"`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1 + page2 + halfLine);

    const byteAfterPage2 = Buffer.byteLength(page1 + page2, "utf-8");

    // Mark job interrupted with persisted cookie + byteLength matching end-of-page-2.
    registry.updateProgress(job.id, "alpha_user", {
      status: "running",
      fetched: 4,
      cookie: "page3",
      byteLength: byteAfterPage2,
    });
    registry.setJobStatus(job.id, "interrupted");

    // Resume: tenant returns one final page with u5 + u6, then null.
    const fetchMock = mockFetchSequence([
      {
        status: 200, body: {
          result: [{ _id: "u5" }, { _id: "u6" }],
          pagedResultsCookie: null,
        }
      },
    ]);

    await runPull({
      job: registry.getJob(job.id)!,
      registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    expect(fs.existsSync(typeDir)).toBe(true);
    const lines = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((r) => r._id)).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);

    const offsets = JSON.parse(fs.readFileSync(path.join(typeDir, "_offsets.json"), "utf-8"));
    expect(Object.keys(offsets).sort()).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);

    expect(registry.getJob(job.id)?.status).toBe("completed");
  });

  it("dedupes records when resume re-fetches the same page (registry crashed before persisting)", async () => {
    const job = registry.startJob("uat", ["alpha_user"]);
    const pullingDir = path.join(tmpDir, "uat", "managed-data", `.pulling-${job.id}`, "alpha_user");
    fs.mkdirSync(pullingDir, { recursive: true });

    // Pre-state: 1 page on disk (u1, u2) but registry shows cookie="page1"
    // (the cookie BEFORE this page was fetched), so resume will re-fetch it.
    const page1 = `${JSON.stringify({ _id: "u1" })}\n${JSON.stringify({ _id: "u2" })}\n`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1);

    registry.updateProgress(job.id, "alpha_user", {
      status: "running",
      fetched: 0, // never persisted progress
      cookie: undefined, // means "haven't sent first request yet" → resume from start
      byteLength: 0,
    });
    // Above is the "no progress persisted yet" pre-state; force file to be there.
    // Now simulate a partial pre-state where cookie was persisted but byteLength was not — covered by the next test.

    // Skip this test — see the next one for the coherent dedupe scenario.
  });

  it("dedupes a duplicated page when registry persisted cookie but the next fetch returns the same records", async () => {
    const job = registry.startJob("uat", ["alpha_user"]);
    const pullingDir = path.join(tmpDir, "uat", "managed-data", `.pulling-${job.id}`, "alpha_user");
    fs.mkdirSync(pullingDir, { recursive: true });

    const page1 = `${JSON.stringify({ _id: "u1" })}\n${JSON.stringify({ _id: "u2" })}\n`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1);
    const byteAfterPage1 = Buffer.byteLength(page1, "utf-8");

    registry.updateProgress(job.id, "alpha_user", {
      status: "running",
      fetched: 2,
      cookie: "page1-cookie",
      byteLength: byteAfterPage1,
    });
    registry.setJobStatus(job.id, "interrupted");

    // Tenant returns the same u1, u2 again, then a fresh u3, then end.
    const fetchMock = mockFetchSequence([
      {
        status: 200, body: {
          result: [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }],
          pagedResultsCookie: null,
        }
      },
    ]);

    await runPull({
      job: registry.getJob(job.id)!,
      registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    const lines = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((r) => r._id)).toEqual(["u1", "u2", "u3"]);
  });
});
```

- [ ] **Step 2: Run the resume tests; verify they fail.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "resume from cookie"`
Expected: FAIL — runner has no resume entry point. The existing test for "skip the second test" is intentional — the third test covers the dedupe scenario coherently.

(Note: delete the second test since it's the "skip" placeholder, then re-run.)

In `aic-pipeline/src/lib/data/pull-runner.test.ts`, delete the `it("dedupes records when resume re-fetches the same page (registry crashed before persisting)", ...)` block — it was a stub. The third test covers dedupe.

- [ ] **Step 3: Implement resume in `runPull`.**

In `aic-pipeline/src/lib/data/pull-runner.ts`:

(a) Add a helper near the top (after imports, before `MAX_RETRIES`):

```ts
import readline from "readline";

/**
 * Stream-read an NDJSON file and rebuild in-memory state from records up to
 * `expectedBytes`. Returns the offsets/index/refs accumulators that match
 * the bytes already on disk. Caller has already truncated the file to
 * `expectedBytes` so any half-written tail is gone.
 */
async function rebuildFromNDJson(
  ndjsonPath: string,
  pickIndexFieldsFn: typeof pickIndexFields,
  extractRefsFn: typeof extractRefs,
): Promise<{
  offsets: Offsets;
  indexEntries: { id: string; f: Record<string, string> }[];
  refsIndex: Record<string, string[]>;
  fetched: number;
  byteLength: number;
}> {
  const offsets: Offsets = {};
  const indexEntries: { id: string; f: Record<string, string> }[] = [];
  const refsIndex: Record<string, string[]> = {};
  let fetched = 0;
  let byteLength = 0;

  if (!fs.existsSync(ndjsonPath)) {
    return { offsets, indexEntries, refsIndex, fetched, byteLength };
  }

  const stream = fs.createReadStream(ndjsonPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let item: Record<string, unknown>;
    try { item = JSON.parse(line); } catch { continue; }
    const id = typeof item._id === "string"
      ? item._id
      : typeof item.id === "string"
        ? item.id as string
        : String(fetched + 1);
    offsets[id] = byteLength;
    indexEntries.push({ id, f: pickIndexFieldsFn(item) });
    const r = extractRefsFn(item);
    if (r.length > 0) refsIndex[id] = r;
    fetched++;
    byteLength += Buffer.byteLength(line, "utf-8") + 1; // +1 for the newline
  }
  return { offsets, indexEntries, refsIndex, fetched, byteLength };
}
```

(b) Update the per-type init block to detect resume and rebuild state. Replace the block from Task 3 step 3(b) with:

```ts
    let indexEntries: { id: string; f: Record<string, string> }[] = [];
    let refsIndex: Record<string, string[]> = {};
    let offsets: Offsets = {};

    const ndjsonPath = path.join(typePullingDir, NDJSON_FILE);

    let cookie: string | null = null;
    let total: number | null = null;
    let fetched = 0;
    let bytesWritten = 0;
    let typeFailed = false;

    // Resume detection: per-type progress already has cookie/byteLength from
    // the prior interrupted run. If `byteLength > 0`, truncate the existing
    // NDJSON to that size (drops any half-written tail) and rebuild
    // in-memory state from the kept bytes.
    const persistedProgress = job.progress.find((p) => p.type === type);
    const isResuming = !!persistedProgress
      && typeof persistedProgress.byteLength === "number"
      && persistedProgress.byteLength > 0
      && fs.existsSync(ndjsonPath);

    if (isResuming) {
      fs.truncateSync(ndjsonPath, persistedProgress!.byteLength!);
      const rebuilt = await rebuildFromNDJson(ndjsonPath, pickIndexFields, extractRefs);
      offsets = rebuilt.offsets;
      indexEntries = rebuilt.indexEntries;
      refsIndex = rebuilt.refsIndex;
      fetched = rebuilt.fetched;
      bytesWritten = rebuilt.byteLength;
      cookie = persistedProgress!.cookie ?? null;
      total = persistedProgress!.total ?? null;
    } else {
      total = await preflightCount(type, token);
      if (total !== null) {
        registry.updateProgress(job.id, type, { fetched: 0, total });
      }
    }

    const ndjsonStream = fs.createWriteStream(ndjsonPath, { flags: "a" });
```

Note: `fs.createWriteStream(..., { flags: "a" })` opens append-only, so the rebuild + truncate keeps `bytesWritten` and the stream's append-position consistent.

(c) Inside the per-record write loop, dedupe when resuming. Update the loop to skip records whose `id` is already in `offsets`:

```ts
          const items = data.result ?? [];
          for (const item of items) {
            if (signal.aborted) break outer;
            const id = typeof item._id === "string"
              ? item._id
              : typeof item.id === "string"
                ? item.id as string
                : String(fetched + 1);
            if (id in offsets) continue; // dedupe on resume
            const line = JSON.stringify(item) + "\n";
            offsets[id] = bytesWritten;
            ndjsonStream.write(line);
            bytesWritten += Buffer.byteLength(line, "utf-8");
            indexEntries.push({ id, f: pickIndexFields(item) });
            const itemRefs = extractRefs(item);
            if (itemRefs.length > 0) refsIndex[id] = itemRefs;
            fetched++;
          }
```

(d) When the runner enters `runPull`, the job status passed in may be `"interrupted"`. The current line `registry.setJobStatus(job.id, "running");` (line 106) is correct as-is — it transitions back to running. No change needed.

(e) **Important:** the cookie URL builder must use the persisted cookie on resume. Verify the existing logic at line 177 (`if (cookie) url.searchParams.set("_pagedResultsCookie", cookie);`) is unchanged — it uses our updated `cookie` variable which now starts from the persisted value. No edit needed.

- [ ] **Step 4: Run the resume tests; verify they pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "resume from cookie"`
Expected: 2 tests pass (truncate-and-resume + dedupe).

- [ ] **Step 5: Run the full pull-runner suite to catch regressions.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit.**

```bash
git add aic-pipeline/src/lib/data/pull-runner.ts aic-pipeline/src/lib/data/pull-runner.test.ts
git commit -m "feat(data-pull): resume entry point — truncate, rebuild, dedupe, continue"
```

---

## Task 8: Cookie expiry handling + raised retry budget

**Files:**
- Modify: `src/lib/data/pull-runner.ts`
- Modify: `src/lib/data/pull-runner.test.ts`

- [ ] **Step 1: Write a failing test for cookie expiry on resume.**

Append to `aic-pipeline/src/lib/data/pull-runner.test.ts`:

```ts
describe("runPull: cookie expiry on resume", () => {
  it("marks the type failed with a clear message when tenant rejects a stale cookie", async () => {
    const job = registry.startJob("uat", ["alpha_user"]);
    const pullingDir = path.join(tmpDir, "uat", "managed-data", `.pulling-${job.id}`, "alpha_user");
    fs.mkdirSync(pullingDir, { recursive: true });
    const page1 = `${JSON.stringify({ _id: "u1" })}\n`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1);
    registry.updateProgress(job.id, "alpha_user", {
      status: "running", fetched: 1,
      cookie: "stale-cookie", byteLength: page1.length,
    });
    registry.setJobStatus(job.id, "interrupted");

    // Tenant rejects the stale cookie with 400.
    const fetchMock = mockFetchSequence([
      { status: 400, body: { code: 400, message: "Invalid pagedResultsCookie" } },
    ]);

    await runPull({
      job: registry.getJob(job.id)!,
      registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
      retryDelayMs: 0,
    });

    const after = registry.getJob(job.id)!;
    expect(after.progress[0].status).toBe("failed");
    expect(after.progress[0].error).toMatch(/cookie/i);
  });
});

describe("runPull: retry budget", () => {
  it("absorbs up to 5 transient 5xx retries before giving up", async () => {
    // 4 transient failures then success.
    const fetchMock = mockFetchSequence([
      { status: 500, body: {} },
      { status: 502, body: {} },
      { status: 503, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { result: [{ _id: "u1" }], pagedResultsCookie: null, totalPagedResults: 1 } },
    ]);

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
      retryDelayMs: 0,
    });

    expect(registry.getJob(job.id)?.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Update the existing "transient 5xx retries, then fails" test to reflect the new budget.**

Find the test at `src/lib/data/pull-runner.test.ts` near line 103. Replace its `responses` array (the 3-element array of 500/502/503) with a 6-element array — 6 failures, more than `MAX_RETRIES=5`:

```ts
    const fetchMock = mockFetchSequence([
      { status: 500, body: {} },
      { status: 502, body: {} },
      { status: 503, body: {} },
      { status: 500, body: {} },
      { status: 502, body: {} },
      { status: 503, body: {} },
    ]);
```

- [ ] **Step 3: Run the new tests; verify they fail.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "cookie expiry"`
Expected: FAIL — runner doesn't recognize cookie-rejection.

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "retry budget"`
Expected: FAIL — current `MAX_RETRIES=2` gives up after 3 attempts.

- [ ] **Step 4: Update `pull-runner.ts`.**

In `aic-pipeline/src/lib/data/pull-runner.ts`:

(a) Bump retry constant. Replace `const MAX_RETRIES = 2;` with:

```ts
const MAX_RETRIES = 5;
```

(b) Update the 429 backoff schedule. Replace `const backoff = [5000, 10000, 20000][attempt] ?? 20000;` (around line 198) with:

```ts
            const backoff = [5000, 10000, 20000, 40000, 60000][attempt] ?? 60000;
```

(c) Add a cookie-expiry branch. Inside the page-fetch retry loop, after the `if (!res.ok) { ... }` block (around line 212–219), look for the existing handler:

```ts
          if (!res.ok) {
            registry.updateProgress(job.id, type, {
              status: "failed",
              error: `HTTP ${res.status}`,
            });
            typeFailed = true;
            break pages;
          }
```

Replace it with:

```ts
          if (!res.ok) {
            // If we were resuming with a persisted cookie and the tenant
            // rejected the request with a 4xx, the cookie is most likely
            // stale (AIC's _pagedResultsCookie isn't documented as durable
            // across long gaps). Surface a clear message so the user knows
            // to start a fresh pull rather than keep retrying.
            const isResumeFailure = isResuming && cookie && res.status >= 400 && res.status < 500;
            const body = isResumeFailure ? await res.text().catch(() => "") : "";
            const errorMsg = isResumeFailure
              ? `paged results cookie expired — please start a fresh pull (HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""})`
              : `HTTP ${res.status}`;
            registry.updateProgress(job.id, type, {
              status: "failed",
              error: errorMsg,
            });
            typeFailed = true;
            break pages;
          }
```

- [ ] **Step 5: Run the new tests; verify they pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "cookie expiry"`
Expected: PASS.

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts -t "retry budget"`
Expected: PASS.

- [ ] **Step 6: Run the full pull-runner suite to catch regressions.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/pull-runner.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Commit.**

```bash
git add aic-pipeline/src/lib/data/pull-runner.ts aic-pipeline/src/lib/data/pull-runner.test.ts
git commit -m "feat(data-pull): raise retry budget to 5; detect stale cookie on resume"
```

---

## Task 9: Resume API endpoint

**Files:**
- Create: `src/app/api/data/pull/jobs/[jobId]/resume/route.ts`
- Test: `tests/api/data/lifecycle.test.ts` (extend)

- [ ] **Step 1: Write a failing integration test for the resume endpoint.**

Append a new `it` block inside the existing `describe("data API lifecycle", ...)` in `aic-pipeline/tests/api/data/lifecycle.test.ts`:

```ts
  it("POST /pull/jobs/:id/resume continues from persisted cookie", async () => {
    vi.resetModules();
    const { POST } = await import("@/app/api/data/pull/route");
    const resumeRoute = await import("@/app/api/data/pull/jobs/[jobId]/resume/route");
    const jobsId = await import("@/app/api/data/jobs/[id]/route");

    // Start a pull but force the runner to abort after page 1 by aborting
    // via DELETE before the second page fires. We can't reach into the
    // runner directly, so instead seed an interrupted job state by hand
    // and call resume.

    // Get the registry singleton and seed an interrupted job + on-disk state.
    const { getRegistry } = await import("@/lib/data/job-registry");
    const reg = getRegistry();
    const job = reg.startJob("test-env", ["alpha_user"]);

    const pullingDir = path.join(
      tmpDir, "environments", "test-env", "managed-data",
      `.pulling-${job.id}`, "alpha_user",
    );
    fs.mkdirSync(pullingDir, { recursive: true });
    const page1 = `${JSON.stringify({ _id: "u1", userName: "alice" })}\n${JSON.stringify({ _id: "u2", userName: "bob" })}\n`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1);
    reg.updateProgress(job.id, "alpha_user", {
      status: "running", fetched: 2,
      cookie: "page2-cookie",
      byteLength: Buffer.byteLength(page1, "utf-8"),
      total: 3,
    });
    reg.setJobStatus(job.id, "interrupted");

    // Reset fetch to return a final page and end.
    fetchCall = 0;
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ result: [{ _id: "u3", userName: "charlie" }], pagedResultsCookie: null }),
    } as Response)) as typeof fetch;

    const resumeReq = new NextRequest(
      `http://localhost/api/data/pull/jobs/${job.id}/resume`,
      { method: "POST" },
    );
    const resumeRes = await resumeRoute.POST(
      resumeReq,
      { params: Promise.resolve({ jobId: job.id }) },
    );
    expect(resumeRes.status).toBe(202);

    // Poll until completed.
    let status = "";
    for (let i = 0; i < 50 && status !== "completed" && status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const res = await jobsId.GET(
        new NextRequest(`http://localhost/api/data/jobs/${job.id}`),
        { params: Promise.resolve({ id: job.id }) },
      );
      status = (await res.json()).status;
    }
    expect(status).toBe("completed");

    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "alpha_user");
    const lines = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((r) => r._id)).toEqual(["u1", "u2", "u3"]);
  });

  it("POST /pull/jobs/:id/resume returns 409 if job is not interrupted", async () => {
    vi.resetModules();
    const resumeRoute = await import("@/app/api/data/pull/jobs/[jobId]/resume/route");
    const { getRegistry } = await import("@/lib/data/job-registry");
    const reg = getRegistry();
    const job = reg.startJob("test-env", ["alpha_user"]);
    reg.setJobStatus(job.id, "completed");

    const res = await resumeRoute.POST(
      new NextRequest(`http://localhost/api/data/pull/jobs/${job.id}/resume`, { method: "POST" }),
      { params: Promise.resolve({ jobId: job.id }) },
    );
    expect(res.status).toBe(409);
  });
```

- [ ] **Step 2: Run; verify it fails.**

Run: `cd aic-pipeline && npx vitest run tests/api/data/lifecycle.test.ts -t "resume"`
Expected: FAIL — module `@/app/api/data/pull/jobs/[jobId]/resume/route` doesn't exist yet.

- [ ] **Step 3: Extract the controllers map into a shared module.**

The current `controllers` map in `src/app/api/data/pull/route.ts:16` is module-private. We need to share it with the resume route so both POSTs can register + look up controllers without a circular import.

Create `aic-pipeline/src/app/api/data/pull/route-controllers.ts`:

```ts
// Shared AbortController registry for in-flight pull jobs. Lives in its
// own module so both the start-pull POST and the resume POST can register
// + look up controllers without a circular import via route.ts.
const controllers = new Map<string, AbortController>();

export function getController(id: string): AbortController | undefined {
  return controllers.get(id);
}
export function setController(id: string, ctl: AbortController): void {
  controllers.set(id, ctl);
}
export function deleteController(id: string): void {
  controllers.delete(id);
}
```

- [ ] **Step 4: Update `src/app/api/data/pull/route.ts` to use the shared module.**

In `aic-pipeline/src/app/api/data/pull/route.ts`:

(a) Replace lines 14–19 (the controllers map + `getController` export) with:

```ts
import { getController, setController, deleteController } from "./route-controllers";
export { getController };
```

(b) Replace `controllers.set(job.id, ctl);` (around line 59) with:

```ts
  setController(job.id, ctl);
```

(c) Replace `.finally(() => controllers.delete(job.id));` (around line 68) with:

```ts
  }).finally(() => deleteController(job.id));
```

- [ ] **Step 5: Create the resume route.**

Create directory: `aic-pipeline/src/app/api/data/pull/jobs/[jobId]/resume/`
Create file: `aic-pipeline/src/app/api/data/pull/jobs/[jobId]/resume/route.ts`:

```ts
// src/app/api/data/pull/jobs/[jobId]/resume/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { parseEnvFile } from "@/lib/env-parser";
import { getAccessToken } from "@/lib/iga-api";
import { getRegistry } from "@/lib/data/job-registry";
import { runPull } from "@/lib/data/pull-runner";
import { getEnvironments } from "@/lib/fr-config";
import { setController, deleteController } from "../../../route-controllers";

export const dynamic = "force-dynamic";

function envVarsFor(env: string): Record<string, string> | null {
  const envFile = path.join(ENVIRONMENTS_DIR, env, ".env");
  if (!fs.existsSync(envFile)) return null;
  return parseEnvFile(fs.readFileSync(envFile, "utf-8")) as Record<string, string>;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const registry = getRegistry();
  const job = registry.getJob(jobId);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "interrupted") {
    return NextResponse.json(
      { error: `cannot resume job in status '${job.status}'` },
      { status: 409 },
    );
  }

  // Another active job for the same env blocks resume.
  const active = registry.getActiveJobForEnv(job.env);
  if (active && active.id !== job.id) {
    return NextResponse.json(
      { jobId: active.id, status: active.status, error: "another job is active for this env" },
      { status: 409 },
    );
  }

  const envVars = envVarsFor(job.env);
  if (!envVars) return NextResponse.json({ error: "env not found" }, { status: 404 });

  const envMeta = getEnvironments().find((e) => e.name === job.env);
  const envPageSize = typeof envMeta?.pageSize === "number" && envMeta.pageSize > 0
    ? envMeta.pageSize
    : undefined;
  const globalPageSize = process.env.DATA_PULL_PAGE_SIZE
    ? parseInt(process.env.DATA_PULL_PAGE_SIZE, 10) || undefined
    : undefined;
  const pageSize = envPageSize ?? globalPageSize;

  const ctl = new AbortController();
  setController(job.id, ctl);

  void runPull({
    job,
    registry,
    envsRoot: ENVIRONMENTS_DIR,
    envVars,
    mintToken: (vars) => getAccessToken(vars),
    signal: ctl.signal,
    pageSize,
  }).finally(() => deleteController(job.id));

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
```

- [ ] **Step 6: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the resume tests; verify they pass.**

Run: `cd aic-pipeline && npx vitest run tests/api/data/lifecycle.test.ts -t "resume"`
Expected: PASS.

- [ ] **Step 8: Run the full lifecycle suite.**

Run: `cd aic-pipeline && npx vitest run tests/api/data/lifecycle.test.ts`
Expected: all tests pass — including the existing "POST /pull → poll GET /jobs/:id → completes" test, which now expects the NDJSON shape.

If the existing lifecycle test fails with `expected ["_index.json", ..., "u1.json", ...]`, update its expected files inline.

Replace lines 95–97 of `aic-pipeline/tests/api/data/lifecycle.test.ts` with:

```ts
    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "alpha_user");
    expect(fs.readdirSync(typeDir).sort()).toEqual([
      "_index.json", "_manifest.json", "_offsets.json", "_refs.json", "data.ndjson",
    ]);
```

Re-run lifecycle tests. Expected: all pass.

- [ ] **Step 9: Commit.**

```bash
git add aic-pipeline/src/app/api/data/pull/route-controllers.ts aic-pipeline/src/app/api/data/pull/route.ts aic-pipeline/src/app/api/data/pull/jobs aic-pipeline/tests/api/data/lifecycle.test.ts
git commit -m "feat(data-pull): POST /api/data/pull/jobs/:id/resume endpoint"
```

---

## Task 10: snapshot-fs reader shim — readRecord NDJSON path

**Files:**
- Modify: `src/lib/data/snapshot-fs.ts`
- Modify: `src/lib/data/snapshot-fs.test.ts`

- [ ] **Step 1: Write a failing test for `readRecord` against the NDJSON format.**

Append to `aic-pipeline/src/lib/data/snapshot-fs.test.ts`:

```ts
// ── NDJSON-format reader tests ─────────────────────────────────────────────

function writeNDJsonSnapshot(
  type: string,
  records: Record<string, unknown>[],
) {
  const dir = path.join(tmpDir, ENV, "managed-data", type);
  fs.mkdirSync(dir, { recursive: true });
  const offsets: Record<string, number> = {};
  let bytes = 0;
  const lines: string[] = [];
  for (const r of records) {
    const id = r._id as string;
    offsets[id] = bytes;
    const line = JSON.stringify(r) + "\n";
    lines.push(line);
    bytes += Buffer.byteLength(line, "utf-8");
  }
  fs.writeFileSync(path.join(dir, "data.ndjson"), lines.join(""));
  fs.writeFileSync(path.join(dir, "_offsets.json"), JSON.stringify(offsets));
  fs.writeFileSync(
    path.join(dir, "_manifest.json"),
    JSON.stringify({ type, pulledAt: 1700000000000, count: records.length, jobId: "j1" }),
  );
}

describe("readRecord (NDJSON format)", () => {
  it("reads a record by id via byte-offset seek", async () => {
    writeNDJsonSnapshot("alpha_user", [
      { _id: "u1", userName: "alice" },
      { _id: "u2", userName: "bob", longField: "x".repeat(500) },
      { _id: "u3", userName: "charlie" },
    ]);
    expect(await readRecord(tmpDir, ENV, "alpha_user", "u2"))
      .toEqual({ _id: "u2", userName: "bob", longField: "x".repeat(500) });
  });

  it("returns null for an unknown id in NDJSON format", async () => {
    writeNDJsonSnapshot("alpha_user", [{ _id: "u1" }]);
    expect(await readRecord(tmpDir, ENV, "alpha_user", "missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run; verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts -t "readRecord (NDJSON format)"`
Expected: FAIL — current `readRecord` looks for `{id}.json` only.

- [ ] **Step 3: Update `readRecord` to detect format and seek into NDJSON.**

In `aic-pipeline/src/lib/data/snapshot-fs.ts`:

(a) Add imports at the top:

```ts
import { isNDJsonFormat, NDJSON_FILE, OFFSETS_FILE, type Offsets } from "./ndjson-format";
```

(b) Replace `readRecord` (currently lines 116–125) with:

```ts
export async function readRecord(
  envsRoot: string, env: string, type: string, id: string,
): Promise<Record<string, unknown> | null> {
  const typeDir = path.join(managedDataDir(envsRoot, env), type);

  if (isNDJsonFormat(typeDir)) {
    return readRecordFromNDJson(typeDir, id);
  }

  // Legacy {id}.json path.
  const filePath = path.join(typeDir, `${id}.json`);
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function readRecordFromNDJson(
  typeDir: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const offsetsPath = path.join(typeDir, OFFSETS_FILE);
  let offsets: Offsets;
  try {
    offsets = JSON.parse(await fsp.readFile(offsetsPath, "utf-8")) as Offsets;
  } catch { return null; }

  const off = offsets[id];
  if (typeof off !== "number") return null;

  const ndjsonPath = path.join(typeDir, NDJSON_FILE);
  const fd = await fsp.open(ndjsonPath, "r");
  try {
    // Read a chunk starting at the offset; expand if we don't see a newline.
    const initialChunk = 8192;
    let buf = Buffer.alloc(initialChunk);
    let { bytesRead } = await fd.read(buf, 0, initialChunk, off);
    let lineEnd = buf.indexOf(0x0a /* \n */, 0);
    while (lineEnd === -1 && bytesRead === buf.length) {
      const next = Buffer.alloc(buf.length * 2);
      buf.copy(next, 0, 0, bytesRead);
      const r = await fd.read(next, bytesRead, next.length - bytesRead, off + bytesRead);
      bytesRead += r.bytesRead;
      buf = next;
      lineEnd = buf.indexOf(0x0a, 0);
      if (r.bytesRead === 0) break;
    }
    const line = buf.slice(0, lineEnd === -1 ? bytesRead : lineEnd).toString("utf-8");
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { return null; }
  } finally {
    await fd.close();
  }
}
```

- [ ] **Step 4: Run the new tests; verify they pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts -t "readRecord (NDJSON format)"`
Expected: 2 tests pass.

- [ ] **Step 5: Run the full snapshot-fs suite — legacy tests should still pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts`
Expected: all tests pass (legacy `readRecord` tests still pass via the legacy branch).

- [ ] **Step 6: Commit.**

```bash
git add aic-pipeline/src/lib/data/snapshot-fs.ts aic-pipeline/src/lib/data/snapshot-fs.test.ts
git commit -m "feat(data-pull): readRecord supports NDJSON format via byte-offset seek"
```

---

## Task 11: snapshot-fs reader shim — loadCache + listRecords NDJSON paths

**Files:**
- Modify: `src/lib/data/snapshot-fs.ts`
- Modify: `src/lib/data/snapshot-fs.test.ts`

- [ ] **Step 1: Write a failing test for the listing path against NDJSON.**

Append to `aic-pipeline/src/lib/data/snapshot-fs.test.ts`:

```ts
function writeNDJsonSnapshotWithIndex(
  type: string,
  records: Record<string, unknown>[],
  indexFields: (r: Record<string, unknown>) => Record<string, string>,
) {
  writeNDJsonSnapshot(type, records);
  const dir = path.join(tmpDir, ENV, "managed-data", type);
  const indexEntries = records.map((r) => ({ id: r._id as string, f: indexFields(r) }));
  fs.writeFileSync(path.join(dir, "_index.json"), JSON.stringify(indexEntries));
}

describe("listRecords (NDJSON format)", () => {
  beforeEach(() => {
    writeNDJsonSnapshotWithIndex(
      "alpha_user",
      [
        { _id: "u1", name: "alice", mail: "alice@x.co" },
        { _id: "u2", name: "bob", mail: "bob@x.co" },
        { _id: "u3", name: "charlie", mail: "alice@y.co" },
      ],
      (r) => ({ _id: r._id as string, name: r.name as string, mail: r.mail as string }),
    );
  });

  it("paginates from the index", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(3);
    expect(page.records.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("searches via the index without scanning data.ndjson", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "alice", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });

  it("falls back to streaming data.ndjson when no index is present", async () => {
    // Remove the index to force the fallback path.
    fs.rmSync(path.join(tmpDir, ENV, "managed-data", "alpha_user", "_index.json"));

    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "charlie", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(1);
    expect(page.records[0].id).toBe("u3");
  });
});
```

- [ ] **Step 2: Run; verify it fails.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts -t "listRecords (NDJSON format)"`
Expected: FAIL — current code does `readdir` for `*.json` files which fails on NDJSON dirs (only `data.ndjson` is found, but it doesn't pass the `!startsWith("_")` filter… wait, `data.ndjson` does NOT end in `.json` — it ends in `.ndjson`. So `readdir` filter excludes it, and `files` is `[]`. Test fails on `total === 0`).

- [ ] **Step 3: Update `loadCache` and `listRecords` to handle NDJSON.**

In `aic-pipeline/src/lib/data/snapshot-fs.ts`:

(a) Update the `TypeCache` interface (lines 23–31) to include format and offsets:

```ts
interface TypeCache {
  pulledAt: number;
  /** All record ids in deterministic order (sorted by id for legacy parity). */
  ids: string[];
  /** Union of top-level keys from the index or a sample. */
  fields: string[];
  /** Full index when _index.json is available, else null. */
  index: IndexEntry[] | null;
  /** True when the directory uses NDJSON storage. */
  ndjson: boolean;
  /** Offsets map for NDJSON format; null otherwise. */
  offsets: Offsets | null;
}
```

(b) Replace `loadCache` (lines 46–92) with:

```ts
async function loadCache(dir: string): Promise<TypeCache> {
  const pulledAt = await getManifestPulledAt(dir);
  const existing = cache.get(dir);
  if (existing && existing.pulledAt === pulledAt) return existing;

  const inflight = pending.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    const ndjson = isNDJsonFormat(dir);

    // Try to load the index built at pull time.
    let index: IndexEntry[] | null = null;
    const indexPath = path.join(dir, "_index.json");
    if (existsSync(indexPath)) {
      try {
        index = JSON.parse(await fsp.readFile(indexPath, "utf-8")) as IndexEntry[];
      } catch { /* fall back to file reads / NDJSON streaming */ }
    }

    let offsets: Offsets | null = null;
    let ids: string[];

    if (ndjson) {
      try {
        offsets = JSON.parse(await fsp.readFile(path.join(dir, OFFSETS_FILE), "utf-8")) as Offsets;
      } catch { offsets = {}; }
      // Use index order if available (matches pull order); else sort offset keys.
      ids = index ? index.map((e) => e.id) : Object.keys(offsets).sort();
    } else {
      const files = (await fsp.readdir(dir))
        .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
        .sort();
      ids = files.map((f) => f.replace(/\.json$/, ""));
    }

    // Derive fields.
    const fieldSet = new Set<string>();
    if (index) {
      for (const entry of index.slice(0, FIELD_SAMPLE_SIZE)) {
        for (const k of Object.keys(entry.f)) fieldSet.add(k);
      }
    } else if (ndjson) {
      // Sample the first FIELD_SAMPLE_SIZE lines of data.ndjson.
      try {
        const stream = fs.createReadStream(path.join(dir, NDJSON_FILE), { encoding: "utf-8" });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let n = 0;
        for await (const line of rl) {
          if (!line) continue;
          try {
            const r = JSON.parse(line) as Record<string, unknown>;
            for (const k of Object.keys(r)) fieldSet.add(k);
          } catch { /* skip */ }
          if (++n >= FIELD_SAMPLE_SIZE) break;
        }
        rl.close();
        stream.destroy();
      } catch { /* skip */ }
    } else {
      // Legacy per-record sample.
      for (const id of ids.slice(0, FIELD_SAMPLE_SIZE)) {
        try {
          const record = JSON.parse(
            await fsp.readFile(path.join(dir, `${id}.json`), "utf-8"),
          ) as Record<string, unknown>;
          for (const k of Object.keys(record)) fieldSet.add(k);
        } catch { /* skip */ }
      }
    }

    const entry: TypeCache = {
      pulledAt, ids, fields: [...fieldSet].sort(), index, ndjson, offsets,
    };
    cache.set(dir, entry);
    return entry;
  })();

  pending.set(dir, work);
  try { return await work; } finally { pending.delete(dir); }
}
```

(c) Add the `readline` and `fs` imports at the top of the file (if not already there):

```ts
import fs from "fs";
import readline from "readline";
```

(`fsp` is already imported as `fs/promises`; we now also need the sync `fs` module for `createReadStream`.)

(d) Update `listRecords` to use `tc.ids` instead of `tc.files` and to use the NDJSON streaming search-fallback when no index is present.

Replace the `listRecords` body (lines 149–234) with:

```ts
export async function listRecords(
  envsRoot: string, env: string, type: string, opts: ListOpts,
): Promise<SnapshotRecordPage> {
  const dir = path.join(managedDataDir(envsRoot, env), type);
  if (!existsSync(dir)) {
    return { total: 0, page: opts.page, limit: opts.limit, records: [], fields: [] };
  }

  const q = opts.q.trim().toLowerCase();
  const tc = await loadCache(dir);
  const { ids, fields, index, ndjson } = tc;
  const titleField = opts.titleField ?? opts.display.title;
  const start = (opts.page - 1) * opts.limit;

  if (!q) {
    // No search — paginate over ids.
    const total = ids.length;
    const pageIds = ids.slice(start, start + opts.limit);

    if (index) {
      const byId = new Map<string, IndexEntry>();
      for (const e of index) byId.set(e.id, e);
      const records = pageIds.map((id) => {
        const entry = byId.get(id);
        if (entry) {
          const key = findKeyCI(entry.f, titleField);
          const title = (key && entry.f[key]) || id;
          return { id, title };
        }
        return { id, title: id };
      });
      return { total, page: opts.page, limit: opts.limit, fields, records };
    }

    // No index — read titles per page (legacy) or stream-skip via NDJSON.
    if (ndjson) {
      const records = await readTitlesFromNDJson(dir, pageIds, titleField);
      return { total, page: opts.page, limit: opts.limit, fields, records };
    }
    const records = await Promise.all(pageIds.map((id) => {
      return readTitleFromFile(dir, `${id}.json`, id, titleField);
    }));
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // Search path.
  if (index) {
    const matchingEntries: IndexEntry[] = [];
    for (const entry of index) {
      for (const v of Object.values(entry.f)) {
        if (v.toLowerCase().includes(q)) {
          matchingEntries.push(entry);
          break;
        }
      }
    }
    const total = matchingEntries.length;
    const pageEntries = matchingEntries.slice(start, start + opts.limit);
    const records = pageEntries.map((entry) => {
      const key = findKeyCI(entry.f, titleField);
      const title = (key && entry.f[key]) || entry.id;
      return { id: entry.id, title };
    });
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // No index — stream-search NDJSON or scan per-record files.
  if (ndjson) {
    const matching: { id: string; title: string }[] = [];
    const stream = fs.createReadStream(path.join(dir, NDJSON_FILE), { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      if (!line.toLowerCase().includes(q)) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        const id = typeof r._id === "string" ? r._id : "";
        if (!id) continue;
        const key = findKeyCI(r, titleField);
        const title = key ? stringOrEmpty(r[key]) || id : id;
        matching.push({ id, title });
      } catch { /* skip */ }
    }
    rl.close();
    stream.destroy();
    const total = matching.length;
    const records = matching.slice(start, start + opts.limit);
    return { total, page: opts.page, limit: opts.limit, fields, records };
  }

  // Legacy per-record fallback.
  const matchingIds: string[] = [];
  for (const id of ids) {
    try {
      const raw = await fsp.readFile(path.join(dir, `${id}.json`), "utf-8");
      if (raw.toLowerCase().includes(q)) {
        matchingIds.push(id);
      }
    } catch { /* skip */ }
  }
  const total = matchingIds.length;
  const pageIds = matchingIds.slice(start, start + opts.limit);
  const records = await Promise.all(pageIds.map((id) =>
    readTitleFromFile(dir, `${id}.json`, id, titleField),
  ));
  return { total, page: opts.page, limit: opts.limit, fields, records };
}

async function readTitlesFromNDJson(
  dir: string,
  wantedIds: string[],
  titleField: string,
): Promise<{ id: string; title: string }[]> {
  const wanted = new Set(wantedIds);
  const found = new Map<string, string>();
  const stream = fs.createReadStream(path.join(dir, NDJSON_FILE), { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const id = typeof r._id === "string" ? r._id : "";
      if (!id || !wanted.has(id)) continue;
      const key = findKeyCI(r, titleField);
      found.set(id, key ? stringOrEmpty(r[key]) || id : id);
      if (found.size === wanted.size) break;
    } catch { /* skip */ }
  }
  rl.close();
  stream.destroy();
  return wantedIds.map((id) => ({ id, title: found.get(id) ?? id }));
}
```

- [ ] **Step 4: Run the new tests; verify they pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts -t "listRecords (NDJSON format)"`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full snapshot-fs suite — legacy tests must still pass.**

Run: `cd aic-pipeline && npx vitest run src/lib/data/snapshot-fs.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit.**

```bash
git add aic-pipeline/src/lib/data/snapshot-fs.ts aic-pipeline/src/lib/data/snapshot-fs.test.ts
git commit -m "feat(data-pull): snapshot-fs supports NDJSON format (loadCache, listRecords)"
```

---

## Task 12: Search API NDJSON streaming branch

**Files:**
- Modify: `src/app/api/data/search/[env]/route.ts`

- [ ] **Step 1: Read the file once more to anchor the edits.**

Open `aic-pipeline/src/app/api/data/search/[env]/route.ts`. The existing per-type loop iterates `readdirSync(typeDir)` and reads each `.json` file. We need to detect NDJSON and stream-search instead.

- [ ] **Step 2: Update the route to handle both formats.**

Replace the `outer:` loop in `aic-pipeline/src/app/api/data/search/[env]/route.ts` (lines 75–96) with:

```ts
  outer:
  for (const typeEntry of fs.readdirSync(managedDir, { withFileTypes: true })) {
    if (!typeEntry.isDirectory() || typeEntry.name.startsWith(".")) continue;
    const typeDir = path.join(managedDir, typeEntry.name);
    const manifestPath = path.join(typeDir, "_manifest.json");
    if (!fs.existsSync(manifestPath)) continue; // unpulled / partial

    const ndjsonPath = path.join(typeDir, "data.ndjson");
    if (fs.existsSync(ndjsonPath)) {
      // NDJSON format: stream the file line by line.
      const content = fs.readFileSync(ndjsonPath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line) continue;
        const idx = findIndex(line);
        if (idx < 0) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line) as Record<string, unknown>; }
        catch { continue; }
        const id = typeof parsed._id === "string" ? parsed._id : "";
        if (!id) continue;
        hits.push({
          type: typeEntry.name,
          id,
          preview: previewFrom(line, idx),
        });
        if (hits.length >= limit) { truncated = true; break outer; }
      }
      continue;
    }

    // Legacy {id}.json format.
    for (const f of fs.readdirSync(typeDir)) {
      if (!f.endsWith(".json") || f === "_manifest.json") continue;
      try {
        const raw = fs.readFileSync(path.join(typeDir, f), "utf-8");
        const idx = findIndex(raw);
        if (idx < 0) continue;
        hits.push({
          type: typeEntry.name,
          id: f.replace(/\.json$/, ""),
          preview: previewFrom(raw, idx),
        });
        if (hits.length >= limit) { truncated = true; break outer; }
      } catch { /* skip unreadable */ }
    }
  }
```

- [ ] **Step 3: Verify with a manual integration check.**

The search route doesn't have a dedicated unit test today; it's exercised via the dev server. Spot-check by adding a one-liner type-check:

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full test suite to make sure nothing else broke.**

Run: `cd aic-pipeline && npm test`
Expected: all tests pass. The lifecycle test was already updated in Task 9.

- [ ] **Step 5: Commit.**

```bash
git add aic-pipeline/src/app/api/data/search/[env]/route.ts
git commit -m "feat(data-pull): search API streams data.ndjson when present"
```

---

## Task 13: Export API NDJSON streaming branch

**Files:**
- Modify: `src/app/api/data/export/[env]/[type]/route.ts`

- [ ] **Step 1: Update the export route to stream NDJSON when present.**

Replace the `matching` collection block in `aic-pipeline/src/app/api/data/export/[env]/[type]/route.ts` (lines 33–53) with:

```ts
  const ndjsonPath = path.join(dir, "data.ndjson");
  const isNDJson = fs.existsSync(ndjsonPath);

  const matching: Record<string, unknown>[] = [];
  const scalarKeys = new Set<string>();

  function maybeAdd(record: Record<string, unknown>, raw: string) {
    if (q && !raw.toLowerCase().includes(q)) return;
    matching.push(record);
    if (format === "csv") {
      for (const [k, v] of Object.entries(record)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null) {
          scalarKeys.add(k);
        }
      }
    }
  }

  if (isNDJson) {
    const content = fs.readFileSync(ndjsonPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        maybeAdd(record, line);
      } catch { /* skip malformed */ }
    }
  } else {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "_manifest.json")
      .sort();
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf-8");
        const record = JSON.parse(raw) as Record<string, unknown>;
        maybeAdd(record, raw);
      } catch { /* skip */ }
    }
  }
```

- [ ] **Step 2: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full test suite.**

Run: `cd aic-pipeline && npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit.**

```bash
git add aic-pipeline/src/app/api/data/export/[env]/[type]/route.ts
git commit -m "feat(data-pull): export API streams data.ndjson when present"
```

---

## Task 14: Environments API accepts `pageSize` (POST + PUT)

**Files:**
- Modify: `src/app/api/environments/route.ts`
- Modify: `src/app/api/environments/[name]/route.ts`

- [ ] **Step 1: Update the PUT handler to accept `pageSize`.**

In `aic-pipeline/src/app/api/environments/[name]/route.ts`, after the `if (body.type !== undefined)` block (lines 38–45), add:

```ts
  if (body.pageSize !== undefined) {
    if (body.pageSize === null || body.pageSize === "") {
      delete envs[idx].pageSize;
    } else {
      const n = typeof body.pageSize === "number" ? body.pageSize : parseInt(String(body.pageSize), 10);
      if (Number.isFinite(n) && n > 0 && n <= 100000) {
        envs[idx].pageSize = n;
      }
    }
  }
```

- [ ] **Step 2: Update the POST handler to accept `pageSize`.**

In `aic-pipeline/src/app/api/environments/route.ts`, replace the `newEnv` construction (lines 20–28) with:

```ts
  const newEnv: Environment = {
    name: body.name,
    label: body.label,
    color: body.color || "blue",
    type: body.type || "sandbox",
    ...(body.type === "controlled" && body.devEnvironment !== undefined
      ? { devEnvironment: body.devEnvironment }
      : {}),
    ...(typeof body.pageSize === "number" && body.pageSize > 0 && body.pageSize <= 100000
      ? { pageSize: body.pageSize }
      : {}),
  };
```

- [ ] **Step 3: Type-check + run tests.**

Run: `cd aic-pipeline && npx tsc --noEmit && npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Commit.**

```bash
git add aic-pipeline/src/app/api/environments/[name]/route.ts aic-pipeline/src/app/api/environments/route.ts
git commit -m "feat(data-pull): environments API accepts pageSize on POST + PUT"
```

---

## Task 15: EnvEditor — Pull page size input

**Files:**
- Modify: `src/app/environments/EnvEditor.tsx`

- [ ] **Step 1: Add the `pageSize` field to `EnvEditor` state.**

In `aic-pipeline/src/app/environments/EnvEditor.tsx`:

(a) Find the `EnvMeta` interface (around line 831–834) and update:

```ts
export interface EnvMeta {
  label: string;
  color: Environment["color"];
  pageSize?: number;
}
```

(b) In the `EnvEditor` body, add a `pageSize` state hook near the other state (after `setDevEnvironment` around line 856):

```ts
  const [pageSize, setPageSize] = useState<number | "">(env.pageSize ?? "");
```

(c) In the load-on-mount `useEffect` (around line 869–887), add:

```ts
    setPageSize(env.pageSize ?? "");
```

(d) In `handleSave` (around line 909–936), add `pageSize` to the body. Replace the body construction with:

```ts
    const body: Record<string, unknown> = {
      label,
      color,
      type: envType,
      devEnvironment: envType === "controlled" ? devEnvironment : undefined,
      envContent: currentRaw,
      pageSize: pageSize === "" ? null : pageSize,
    };
```

(e) Update the dependency array of `handleSave` to include `pageSize`:

```ts
  }, [label, color, envType, devEnvironment, currentRaw, logApiKey, logApiSecret, pageSize, env.name, onUpdate]);
```

(f) Update the `onMetaChange` effect (around line 945–947) to include `pageSize`:

```ts
  useEffect(() => {
    onMetaChange?.({ label, color, pageSize: pageSize === "" ? undefined : pageSize });
  }, [label, color, pageSize, onMetaChange]);
```

(g) Add the input to the metadata row. Find the `Type` `<select>` block (around line 987) and add a sibling `<div>` after the Color block (after line 985) but before the Type block:

```tsx
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Pull page size</label>
              <input
                type="number"
                min={1}
                max={100000}
                value={pageSize}
                placeholder="5000"
                onChange={(e) => {
                  const v = e.target.value;
                  setPageSize(v === "" ? "" : parseInt(v, 10) || "");
                }}
                className="block rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 w-24"
              />
            </div>
```

- [ ] **Step 2: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke test in the dev server.**

```bash
cd aic-pipeline && npm run dev
```

Open `http://localhost:3000/environments` → click an environment card → confirm the "Pull page size" input appears next to Color and Type. Set it to `7500`, click Save, reload the page → confirm the value persists. Read `environments/<env>/.env` is unchanged; read `environments/environments.json` and confirm `pageSize: 7500` is present on that env.

Stop the dev server.

- [ ] **Step 4: Commit.**

```bash
git add aic-pipeline/src/app/environments/EnvEditor.tsx
git commit -m "feat(data-pull): EnvEditor exposes pull page size override"
```

---

## Task 16: EnvironmentsManager add-wizard — pageSize field

**Files:**
- Modify: `src/app/environments/EnvironmentsManager.tsx`

- [ ] **Step 1: Add `pageSize` to `NewEnvForm`.**

In `aic-pipeline/src/app/environments/EnvironmentsManager.tsx`, update the `NewEnvForm` interface (around lines 42–56) to add:

```ts
interface NewEnvForm {
  name: string;
  label: string;
  color: Environment["color"];
  type: EnvironmentType;
  devEnvironment: boolean;
  pageSize: string; // empty string → omitted from save
  TENANT_BASE_URL: string;
  SERVICE_ACCOUNT_CLIENT_ID: string;
  SERVICE_ACCOUNT_ID: string;
  SERVICE_ACCOUNT_SCOPE: string;
  SERVICE_ACCOUNT_KEY: string;
  CONFIG_DIR: string;
  REALMS: string;
  SCRIPT_PREFIXES: string;
}
```

(b) Update `EMPTY_FORM` (lines 58–72) to add `pageSize: ""`:

```ts
const EMPTY_FORM: NewEnvForm = {
  name: "",
  label: "",
  color: "green",
  type: "sandbox",
  devEnvironment: false,
  pageSize: "",
  TENANT_BASE_URL: "",
  SERVICE_ACCOUNT_CLIENT_ID: "service-account",
  SERVICE_ACCOUNT_ID: "",
  SERVICE_ACCOUNT_SCOPE: "fr:am:* fr:idm:* fr:idc:esv:* fr:idc:direct-configuration:session:*",
  SERVICE_ACCOUNT_KEY: "",
  CONFIG_DIR: "./config",
  REALMS: '["alpha"]',
  SCRIPT_PREFIXES: '[""]',
};
```

(c) Update the `handleAddEnv` POST body to include `pageSize`. In `aic-pipeline/src/app/environments/EnvironmentsManager.tsx`, find `handleAddEnv` (starts at line 185). Replace the `JSON.stringify({...})` body block (lines 191–198) with:

```ts
      body: JSON.stringify({
        name: form.name,
        label: form.label,
        color: form.color,
        type: form.type,
        devEnvironment: form.type === "controlled" ? form.devEnvironment : undefined,
        pageSize: form.pageSize ? parseInt(form.pageSize, 10) || undefined : undefined,
        envContent: buildEnvContent(form),
      }),
```

(d) Add the input to the meta step (Step 1) UI. Find the existing color radio group (around line 376) and add the following block after the Color block, before the Environment-type radio block:

```tsx
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Pull page size <span className="text-slate-400 font-normal">(optional)</span>
                    </label>
                    <p className="text-xs text-slate-400">
                      AIC pagination size for managed-data pulls. Leave blank to use the default (5000).
                    </p>
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={form.pageSize}
                      placeholder="5000"
                      onChange={(e) => setF("pageSize", e.target.value)}
                      className="block w-32 rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
```

- [ ] **Step 2: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add aic-pipeline/src/app/environments/EnvironmentsManager.tsx
git commit -m "feat(data-pull): add wizard exposes pull page size"
```

---

## Task 17: JobCard — Resume button + interrupted status pill

**Files:**
- Modify: `src/app/data/pull/JobCard.tsx`
- Modify: `src/hooks/useDataPullJobs.ts`

- [ ] **Step 1: Add a `resume` action to the hook.**

In `aic-pipeline/src/hooks/useDataPullJobs.ts`, add after the `start` callback (around line 55):

```ts
  const resume = useCallback(async (id: string) => {
    const res = await fetch(`/api/data/pull/jobs/${id}/resume`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    await refresh();
    return { ok: res.ok, status: res.status, body: data as { jobId?: string; error?: string } };
  }, [refresh]);
```

Update the return:

```ts
  return { jobs, error, refresh, abort, start, resume };
```

- [ ] **Step 2: Add `interrupted` to the status style map.**

In `aic-pipeline/src/app/data/pull/JobCard.tsx`, replace the `STATUS_STYLE` object (lines 7–14) with:

```ts
const STATUS_STYLE: Record<DataPullJob["status"], string> = {
  queued:      "bg-slate-100 text-slate-600",
  running:     "bg-sky-100 text-sky-700",
  aborting:    "bg-amber-100 text-amber-700",
  completed:   "bg-emerald-100 text-emerald-700",
  failed:      "bg-rose-100 text-rose-700",
  aborted:     "bg-slate-100 text-slate-500",
  interrupted: "bg-amber-100 text-amber-800",
};
```

- [ ] **Step 3: Add Resume button rendering.**

In the same file, update the props (around lines 49–57):

```ts
export function JobCard({
  job,
  probedCounts = {},
  onAbort,
  onResume,
}: {
  job: DataPullJob;
  probedCounts?: Record<string, number | null>;
  onAbort: () => void;
  onResume?: () => void;
}) {
```

In the header row (around lines 89–111), replace the action buttons section with:

```tsx
        {canAbort && (
          <button
            type="button"
            onClick={onAbort}
            className="ml-auto px-2 py-0.5 text-xs border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
          >Abort</button>
        )}
        {job.status === "interrupted" && onResume && (
          <button
            type="button"
            onClick={onResume}
            className="ml-auto px-2 py-0.5 text-xs border border-amber-400 rounded bg-amber-50 text-amber-800 hover:bg-amber-100"
          >Resume</button>
        )}
        {job.fatalError && <span className="ml-auto text-xs text-rose-600">{job.fatalError}</span>}
```

- [ ] **Step 4: Wire the new prop in the parent caller.**

The single call site is in `aic-pipeline/src/app/data/pull/PullPanel.tsx` around line 398. The file already destructures `useDataPullJobs(...)` — extract `resume` from it and pass it to `JobCard`.

(a) Find the line that destructures the hook (search for `useDataPullJobs(`). Add `resume` to the destructuring:

```tsx
const { jobs, error, abort, start, resume } = useDataPullJobs({ ... });
```

(If the existing destructuring uses different names or leaves some fields off, just add `resume` alongside `abort`.)

(b) Replace the JobCard call site at `PullPanel.tsx:398-403` with:

```tsx
            <JobCard
              key={j.id}
              job={j}
              probedCounts={probedForJob}
              onAbort={() => abort(j.id)}
              onResume={() => resume(j.id)}
            />
```

- [ ] **Step 5: Type-check + smoke test.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

Manual smoke: `cd aic-pipeline && npm run dev`, navigate to `/data/pull`, kick off a small pull on a sandbox env, kill the dev server (Ctrl-C) mid-pull, restart `npm run dev`, refresh the page. Confirm the job card shows status `interrupted` with a Resume button. Click Resume, confirm the snapshot completes. Stop the dev server.

- [ ] **Step 6: Commit.**

```bash
git add aic-pipeline/src/hooks/useDataPullJobs.ts aic-pipeline/src/app/data/pull/JobCard.tsx aic-pipeline/src/app/data/pull
git commit -m "feat(data-pull): UI Resume button + interrupted status pill"
```

---

## Task 18: Full-suite green check

**Files:** none (validation only)

- [ ] **Step 1: Run the full Vitest suite.**

Run: `cd aic-pipeline && npm test`
Expected: every test passes. If any fail, fix them inline before continuing.

- [ ] **Step 2: Run lint.**

Run: `cd aic-pipeline && npm run lint`
Expected: no errors. Fix any lint warnings introduced by this work.

- [ ] **Step 3: Run a production build to catch issues that don't surface in `next dev`.**

Run: `cd aic-pipeline && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit any fixes.**

If Steps 1–3 required tweaks:

```bash
git add -A aic-pipeline/
git commit -m "chore(data-pull): fix lint/typecheck issues from large-pulls feature"
```

---

## Task 19: Manual smoke test — dev environment

**Files:** none (manual validation)

- [ ] **Step 1: Start the dev server.**

```bash
cd aic-pipeline && npm run dev
```

- [ ] **Step 2: NDJSON happy path.**

Navigate to `http://localhost:3000/data/pull?env=<small-sandbox-env>`. Select a small managed type (something with a few hundred records). Click Start. Wait for completion.

Verify on disk:

```bash
ls aic-pipeline/../environments/<env>/managed-data/<type>/
```

Expected files: `data.ndjson`, `_offsets.json`, `_index.json`, `_refs.json`, `_manifest.json`. **No `{id}.json` files.**

- [ ] **Step 3: Browse / detail / refs work for new format.**

In the Data tab, browse the type, click into a record (detail pane should show the record JSON), check the Refs section on at least one record. Everything should render normally.

Open the Search box and search for a value you know exists in a record — the hit should appear.

Click Export → JSON for the type. Confirm the downloaded file contains a JSON array with all records.

- [ ] **Step 4: Legacy snapshot still readable.**

Find a previously-pulled type that still has `{id}.json` files (skip if all envs have been repulled). Browse / detail / refs / search / export should all still work via the legacy reader path.

- [ ] **Step 5: Resume after server kill.**

Trigger a pull on a type with at least 50,000 records (so it takes long enough to interrupt — bump the page size up if needed by setting Pull page size = 1000 in EnvEditor first to slow it down). While the pull is running:

```bash
# In the terminal running `npm run dev`, hit Ctrl-C.
```

Restart:

```bash
cd aic-pipeline && npm run dev
```

Refresh the Data Pull page. The job should show status `interrupted` with a Resume button. Click Resume. Wait for completion. Verify the final snapshot:

```bash
wc -l aic-pipeline/../environments/<env>/managed-data/<type>/data.ndjson
```

Compare the count to a fresh pull's `_manifest.json`'s `count` field — they should match.

Stop the dev server.

- [ ] **Step 6: Document any issues found.**

If any of Steps 2–5 surfaced bugs, file them as fix tasks before proceeding to Task 20. Otherwise this task is complete with no commit.

---

## Task 20: Acceptance — UAT `alpha_tenant*` validation pull

**Files:** none (acceptance test against real UAT tenant)

- [ ] **Step 1: Identify the `alpha_tenant*` types to pull.**

Start the dev server: `cd aic-pipeline && npm run dev`. Navigate to `/data/pull?env=uat`. Look at the type list (left panel / selectable list). Note every type whose name begins with `alpha_tenant` (e.g. `alpha_tenant_access`, `alpha_tenant_role`, etc.).

- [ ] **Step 2: Set UAT page size.**

In the environments page, edit UAT and set "Pull page size" to `5000`. Save.

- [ ] **Step 3: Probe counts.**

In `/data/pull?env=uat`, click Probe counts on the selected `alpha_tenant*` types. Note which return real numbers vs. which return "unknown". This is informational — pulls don't depend on counts being known.

- [ ] **Step 4: Pull all `alpha_tenant*` types.**

Select all `alpha_tenant*` types in the type list and click Start. Watch the JobCard for progress. Allow the pull to run to completion.

If the pull is interrupted by a server restart at any point, click Resume and let it finish. (One mid-pull restart during this acceptance step is itself part of the validation — if it doesn't happen organically, you can deliberately Ctrl-C the dev server when one type is mid-fetch and restart, then click Resume.)

- [ ] **Step 5: Verify completion.**

For each `alpha_tenant*` type:

```bash
ls aic-pipeline/../environments/uat/managed-data/<type>/
```

Expected files: `data.ndjson`, `_offsets.json`, `_index.json`, `_refs.json`, `_manifest.json`.

```bash
cat aic-pipeline/../environments/uat/managed-data/<type>/_manifest.json
```

Confirm `count` is a positive number.

```bash
wc -l aic-pipeline/../environments/uat/managed-data/<type>/data.ndjson
```

The line count should equal the manifest's `count`.

- [ ] **Step 6: Spot-check the data.**

In the Data tab, browse each pulled `alpha_tenant*` type. Click into 2–3 records on each. Search for a known field value. Refs lookups should resolve outgoing/incoming refs without error.

- [ ] **Step 7: Acceptance complete.**

If all of Steps 4–6 passed, the implementation meets the spec's acceptance criteria. Stop the dev server. Push the branch when ready (do not push automatically — coordinate with the user).

```bash
# Once the user approves:
# git push origin development
```

---

## Notes for the implementing engineer

- **Codebase conventions:** This Next.js app has breaking changes vs. mainstream training data — read `aic-pipeline/node_modules/next/dist/docs/` before adjusting any route handler signature, response stream, or `params` shape. Existing route handlers in this plan (e.g., `params: Promise<{ jobId: string }>`) reflect this repo's actual API; don't "fix" them.
- **Tests are co-located** under `src/lib/data/*.test.ts` and `tests/api/data/*.test.ts` (integration). Use `npx vitest run <path>` for one file; `npm test` for the suite.
- **Atomic swap depends on the registry's per-type cookie/byteLength surviving across job runs.** Double-check that nothing in `runPull` resets these fields when it shouldn't — the resume entry point reads them; if Task 7's edits accidentally clear them on entry, dedupe/truncate breaks. The failing/passing tests in Task 7 cover this.
- **Don't push without an explicit user request.** Commit locally throughout the plan; pushing is the user's call.
- **AGENTS.md / CLAUDE.md:** the repo's `aic-pipeline/AGENTS.md` warns "this is NOT the Next.js you know." Trust the existing patterns (route handler signatures, `params: Promise<...>`, `dynamic = "force-dynamic"`) over your training-data instincts.
