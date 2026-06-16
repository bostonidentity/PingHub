# Scheduler Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-process scheduler to PingHub that fires config-sync, data-pull, and git commit-and-push operations on time triggers (presets or cron), individually or chained as a pipeline, with results recorded in the existing History.

**Architecture:** Extract each operation's core logic out of its Next.js route handler into a reusable lib function (`runSync`/`runDataPull`/`runGitPush`) that emits events via a callback and returns an `OpResult`; the existing routes keep their browser-facing JSONL stream by passing an enqueue callback. A tick-based scheduler (started from `instrumentation.ts`) reads schedules from `schedules.json`, fires due ones by calling the cores, and records runs to the existing op-log.

**Tech Stack:** Next.js 16 (App Router) + TypeScript, React 19, Vitest for tests, `cron-parser` for cron math, Node `crypto.randomUUID()` for IDs, `better-sqlite3`/JSON-file persistence patterns already in the repo.

**Working directory for all paths below:** `/Users/ledeng/projects/PingHub/ping-aic-studio`

---

## File Structure

**New files:**
- `src/lib/operations/types.ts` — `OpResult`, `OpEvent`, `OpEventSink` shared types.
- `src/lib/operations/run-sync.ts` — `runSync()` core (extracted from `api/pull/route.ts`).
- `src/lib/operations/run-git-push.ts` — `runGitPush()` core (wraps `git/push` whole-repo logic).
- `src/lib/operations/run-data-pull.ts` — `runDataPull()` core (kicks off + awaits a data-pull job).
- `src/lib/scheduler/types.ts` — `Schedule`, `Step`, `Trigger`, `ScheduleRunRef` types.
- `src/lib/scheduler/cron.ts` — `presetToCron()`, `computeNextRun()`.
- `src/lib/scheduler/store.ts` — read/write `schedules.json` (atomic), CRUD helpers.
- `src/lib/scheduler/engine.ts` — `startScheduler()`, `stopScheduler()`, `tick()`, `runSchedule()`.
- `src/instrumentation.ts` — Next.js boot hook that calls `startScheduler()`.
- `src/app/api/schedules/route.ts` — `GET` (list) / `POST` (create).
- `src/app/api/schedules/[id]/route.ts` — `GET` / `PUT` / `DELETE`.
- `src/app/api/schedules/[id]/run/route.ts` — `POST` (run now).
- `src/app/schedules/page.tsx` — Schedules list page.
- `src/app/schedules/ScheduleList.tsx` — list UI (client component).
- `src/app/schedules/ScheduleEditor.tsx` — create/edit modal (client component).

**Modified files:**
- `src/lib/op-history.ts` — add optional `trigger`/`scheduleId` fields to `OpLogInput` + `HistoryRecord`.
- `src/app/api/pull/route.ts` — call `runSync()` instead of inline logic.
- `src/app/api/git/push/route.ts` — extract its commit/push core into `runGitPush()` and call it.
- `package.json` — add `cron-parser` dependency.
- Navigation component (the sidebar/nav that links to `/sync`, `/logs`, etc.) — add a "Schedules" link.

---

## Phase 0: Foundations (dependency + op-log fields)

### Task 1: Add `cron-parser` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

Run: `npm install cron-parser@4`
Expected: `package.json` gains `"cron-parser": "^4.x"` under `dependencies`; `package-lock.json` updates.

- [ ] **Step 2: Verify it imports under the project's module setup**

Run: `node -e "const {CronExpressionParser}=require('cron-parser'); console.log(typeof CronExpressionParser)"`
Expected: prints `function` (cron-parser v4 exports `CronExpressionParser`). If it prints `undefined`, the installed major is different — pin with `npm install cron-parser@4` and re-check.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(scheduler): add cron-parser dependency"
```

### Task 2: Add `trigger`/`scheduleId` fields to the op-log

**Files:**
- Modify: `src/lib/op-history.ts:72-126` (the `HistoryRecord` and `OpLogInput` interfaces)
- Test: `tests/lib/op-history-trigger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/op-history-trigger.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("op-log trigger fields", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oplog-"));
    process.env.PINGHUB_DATA_DIR = dir;
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.PINGHUB_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists trigger and scheduleId on an op-log entry", async () => {
    const { appendOpLog, readOpLog } = await import("@/lib/op-history");
    appendOpLog({
      type: "pull",
      environment: "dev",
      scopes: ["journeys"],
      status: "success",
      startedAt: new Date(0).toISOString(),
      durationMs: 10,
      summary: "ok",
      trigger: "scheduled",
      scheduleId: "sched-1",
    });
    const rows = readOpLog();
    expect(rows[0].trigger).toBe("scheduled");
    expect(rows[0].scheduleId).toBe("sched-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/op-history-trigger.test.ts`
Expected: FAIL — TypeScript error "Object literal may only specify known properties" on `trigger`, or the assertion fails because the field is dropped.

- [ ] **Step 3: Add the fields to both interfaces**

In `src/lib/op-history.ts`, add to `interface OpLogInput` (after `logEntryCount?: number;`):

```ts
  /** How the operation was initiated. Absent = manual (default). */
  trigger?: "manual" | "scheduled";
  /** ID of the schedule that fired this op (scheduled runs only). */
  scheduleId?: string;
```

Add the identical two fields to `interface HistoryRecord` (after `logEntryCount?: number;`).

- [ ] **Step 4: Ensure `appendOpLog` copies the fields through**

Find `appendOpLog` (around `src/lib/op-history.ts:280`). It builds a `HistoryRecord` from the input. Confirm it spreads or explicitly copies optional fields. If it explicitly lists fields (does NOT spread `...input`), add:

```ts
    trigger: input.trigger,
    scheduleId: input.scheduleId,
```

to the constructed record object. If it already does `...input`, no change is needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/lib/op-history-trigger.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/op-history.ts tests/lib/op-history-trigger.test.ts
git commit -m "feat(scheduler): record trigger/scheduleId on op-log entries"
```

---

## Phase 1: Operation cores

### Task 3: Shared operation types

**Files:**
- Create: `src/lib/operations/types.ts`
- Test: none (pure types; exercised by later tasks)

- [ ] **Step 1: Create the types file**

```ts
// src/lib/operations/types.ts

/** A single JSONL event emitted during an operation (same shape the routes stream). */
export type OpEvent = Record<string, unknown> & { type: string; ts?: number };

/** Callback the cores use to emit progress. Routes enqueue to a stream; the
 *  scheduler ignores or buffers. Must never throw back into the core. */
export type OpEventSink = (evt: OpEvent) => void;

/** No-op sink for callers that don't consume events (e.g. the scheduler). */
export const NOOP_SINK: OpEventSink = () => {};

/** Result of running one operation core. */
export interface OpResult {
  status: "success" | "failed";
  /** op-log entry id, when one was written. */
  runId?: string;
  summary: string;
  durationMs: number;
  /** Populated when status === "failed". */
  error?: string;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors referencing `src/lib/operations/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/operations/types.ts
git commit -m "feat(scheduler): shared operation event/result types"
```

### Task 4: Extract `runSync` core from the pull route

The current `api/pull/route.ts` POST handler does: pre-commit → prune → partition scopes → merge runner streams → consume stream watching exit code → post-commit + analyzeChanges → appendOpLog → return stream. We move everything except the HTTP `Response` wrapping into `runSync`, emitting the same events through `OpEventSink`.

**Files:**
- Create: `src/lib/operations/run-sync.ts`
- Test: `tests/lib/operations/run-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/operations/run-sync.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the boundaries the core depends on.
vi.mock("@/lib/git", () => ({
  autoCommit: vi.fn(() => "abc1234"),
  analyzeChanges: vi.fn(() => [{ scope: "journeys", added: ["a"], modified: [], deleted: [] }]),
  pruneScopeDirs: vi.fn(() => []),
  scopeLabel: (s: string) => s,
}));
vi.mock("@/lib/op-history", () => ({ appendOpLog: vi.fn(() => ({ id: "op-1" })) }));
vi.mock("@/lib/fr-config", async (orig) => ({
  ...(await orig()),
  getEnvFileContent: () => "CONFIG_DIR=./config\n",
}));

function fakeStream(lines: string[]) {
  return new ReadableStream<string>({
    start(c) { for (const l of lines) c.enqueue(l + "\n"); c.close(); },
  });
}
vi.mock("@/lib/frodo", () => ({ spawnFrodo: vi.fn(), FRODO_SCOPES: [] }));
vi.mock("@/lib/iga-api", () => ({ runIgaApi: vi.fn(), IGA_API_SCOPES: [] }));
vi.mock("@/lib/fr-config-types", async (orig) => ({ ...(await orig()) }));

const spawnFrConfig = vi.fn(() => ({
  stream: fakeStream([JSON.stringify({ type: "exit", code: 0, ts: 1 })]),
}));
vi.mock("@/lib/fr-config", async (orig) => ({
  ...(await orig()),
  getEnvFileContent: () => "CONFIG_DIR=./config\n",
  spawnFrConfig,
}));

describe("runSync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns success and emits a post-pull-commit event when the pull exits 0", async () => {
    const { runSync } = await import("@/lib/operations/run-sync");
    const events: Record<string, unknown>[] = [];
    const result = await runSync(
      { environment: "dev", scopes: ["journeys"] },
      (e) => events.push(e),
    );
    expect(result.status).toBe("success");
    expect(events.some((e) => e.action === "post-pull-commit")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/operations/run-sync.test.ts`
Expected: FAIL — "Cannot find module '@/lib/operations/run-sync'".

- [ ] **Step 3: Create `run-sync.ts` by lifting the route logic**

```ts
// src/lib/operations/run-sync.ts
import path from "path";
import { spawnFrConfig, ConfigScope, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { autoCommit, analyzeChanges, pruneScopeDirs, scopeLabel as getScopeLabel } from "@/lib/git";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { appendOpLog, type OpMetadata } from "@/lib/op-history";
import { CONFIG_SCOPES } from "@/lib/fr-config-types";
import { spawnFrodo, FRODO_SCOPES } from "@/lib/frodo";
import { runIgaApi, IGA_API_SCOPES } from "@/lib/iga-api";
import { mergeRunnerStreams } from "@/lib/operations/merge-streams";
import type { OpEvent, OpEventSink, OpResult } from "@/lib/operations/types";

export interface RunSyncOpts {
  environment: string;
  scopes?: ConfigScope[];
  /** When set, attach to the op-log entry. */
  trigger?: "manual" | "scheduled";
  scheduleId?: string;
}

export async function runSync(opts: RunSyncOpts, emit: OpEventSink): Promise<OpResult> {
  const { environment, scopes } = opts;
  const scopesList = scopes ?? [];
  const scopeLabel = scopesList.length ? scopesList.join(", ") : "all";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const envVars = parseEnvFile(getEnvFileContent(environment));
  const configDirRel = envVars.CONFIG_DIR ?? "./config";

  // Pre-pull: commit any existing uncommitted changes.
  let preHash: string | null = null;
  let preCommitError: string | null = null;
  try {
    preHash = autoCommit(environment, `auto: save uncommitted changes for ${environment} before pull`, configDirRel);
  } catch (err) {
    preCommitError = err instanceof Error ? err.message : String(err);
  }

  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  if (preCommitError) {
    emit({ type: "git", action: "pre-pull-commit-error", message: `Git commit failed — pull aborted: ${preCommitError}`, ts: Date.now() });
    emit({ type: "exit", code: 1, ts: Date.now() });
    const summary = `Pull aborted: ${preCommitError}`;
    let runId: string | undefined;
    try {
      runId = appendOpLog({ type: "pull", environment, scopes: scopesList.length ? scopesList : ["all"], status: "failed", startedAt, durationMs: Date.now() - startTime, summary, trigger: opts.trigger, scheduleId: opts.scheduleId }).id;
    } catch { /* non-fatal */ }
    return { status: "failed", summary, durationMs: Date.now() - startTime, error: preCommitError, runId };
  }

  const allScopes = scopesList.length
    ? scopesList
    : (CONFIG_SCOPES.filter((s) => s.cliSupported !== false).map((s) => s.value) as ConfigScope[]);

  const configDirAbs = path.resolve(ENVIRONMENTS_DIR, environment, configDirRel);
  let prunedDirs: string[] = [];
  let pruneError: string | null = null;
  try {
    prunedDirs = pruneScopeDirs(configDirAbs, allScopes);
  } catch (err) {
    pruneError = err instanceof Error ? err.message : String(err);
  }

  const frodoScopes = allScopes.filter((s) => FRODO_SCOPES.includes(s));
  const igaScopes = allScopes.filter((s) => IGA_API_SCOPES.includes(s));
  const frScopes = allScopes.filter((s) => !FRODO_SCOPES.includes(s) && !IGA_API_SCOPES.includes(s)) as ConfigScope[];

  const streams: ReadableStream<string>[] = [];
  if (frScopes.length) streams.push(spawnFrConfig({ command: "fr-config-pull", environment, scopes: frScopes }).stream);
  if (frodoScopes.length) streams.push(spawnFrodo({ command: "fr-config-pull", environment, scopes: frodoScopes }).stream);
  if (igaScopes.length) streams.push(runIgaApi({ command: "fr-config-pull", environment, scopes: igaScopes }).stream);

  // Emit pre-pull events.
  if (preHash) emit({ type: "git", action: "pre-pull-commit", hash: preHash, message: `Committed uncommitted changes before pull (${preHash})`, ts: Date.now() });
  else emit({ type: "git", action: "pre-pull-clean", message: "No uncommitted changes — working tree clean", ts: Date.now() });

  if (pruneError) emit({ type: "git", action: "pre-pull-prune-error", message: `Failed to prune scope directories: ${pruneError}`, ts: Date.now() });
  else if (prunedDirs.length === 0) emit({ type: "git", action: "pre-pull-prune-skip", message: "No existing scope directories to prune", ts: Date.now() });
  else for (const dir of prunedDirs) emit({ type: "git", action: "pre-pull-prune", message: `Pruned ${path.relative(process.cwd(), dir)}`, ts: Date.now() });

  // Consume the merged runner stream, forwarding every event and tracking the exit code.
  const pullStream = mergeRunnerStreams(streams);
  const reader = pullStream.getReader();
  let lastExitCode = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split("\n")) {
      if (!line.trim()) continue;
      let parsed: OpEvent;
      try { parsed = JSON.parse(line) as OpEvent; } catch { continue; }
      if (parsed.type === "exit") { lastExitCode = (parsed.code as number) ?? 0; continue; }
      emit(parsed);
    }
  }

  // Post-pull: commit + record history.
  let summary = "Pull failed";
  if (lastExitCode === 0) {
    const changes = analyzeChanges(environment, configDirRel);
    let added = 0, modified = 0, deleted = 0;
    for (const c of changes) { added += c.added.length; modified += c.modified.length; deleted += c.deleted.length; }
    const totalItems = added + modified + deleted;
    const scopeNames = changes.map((c) => getScopeLabel(c.scope)).join(", ");
    summary = totalItems > 0 ? `${totalItems} items across ${changes.length} scope${changes.length !== 1 ? "s" : ""} (${scopeNames})` : "No changes";
    try {
      const metadata: OpMetadata = { operation: "pull", environment, scopes: scopesList.length ? scopesList : ["all"], status: "success", startedAt, durationMs: Date.now() - startTime, added, modified, deleted };
      const postHash = autoCommit(environment, `pull(${environment}): ${scopeLabel} @ ${ts}`, configDirRel, metadata);
      if (postHash) emit({ type: "git", action: "post-pull-commit", hash: postHash, message: `Auto-committed pull results (${postHash})`, ts: Date.now() });
      else emit({ type: "git", action: "post-pull-clean", message: "No changes from pull — nothing to commit", ts: Date.now() });
    } catch (err) {
      emit({ type: "git", action: "post-pull-commit-error", message: `Git commit failed after pull: ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() });
    }
  }

  let runId: string | undefined;
  try {
    runId = appendOpLog({ type: "pull", environment, scopes: scopesList.length ? scopesList : ["all"], status: lastExitCode === 0 ? "success" : "failed", startedAt, durationMs: Date.now() - startTime, summary, trigger: opts.trigger, scheduleId: opts.scheduleId }).id;
  } catch { /* non-fatal */ }

  return { status: lastExitCode === 0 ? "success" : "failed", summary, durationMs: Date.now() - startTime, runId, error: lastExitCode === 0 ? undefined : summary };
}
```

- [ ] **Step 4: Extract the shared `mergeRunnerStreams` helper**

`mergeStreams` is currently duplicated in `api/pull/route.ts` and `api/push/route.ts`. Move it to a shared module so the core and both routes use one copy.

```ts
// src/lib/operations/merge-streams.ts
/** Concatenate runner streams sequentially into one, collapsing their `exit`
 *  events into a single trailing exit carrying the max code. */
export function mergeRunnerStreams(streams: ReadableStream<string>[]): ReadableStream<string> {
  if (streams.length === 0) {
    return new ReadableStream<string>({ start(c) { c.enqueue(JSON.stringify({ type: "exit", code: 0, ts: Date.now() }) + "\n"); c.close(); } });
  }
  if (streams.length === 1) return streams[0];
  return new ReadableStream<string>({
    async start(controller) {
      let lastCode = 0;
      for (const s of streams) {
        const reader = s.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of value.split("\n")) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line) as { type: string; code?: number };
              if (p.type === "exit") { lastCode = Math.max(lastCode, p.code ?? 0); continue; }
            } catch { /* pass through */ }
            controller.enqueue(line + "\n");
          }
        }
      }
      controller.enqueue(JSON.stringify({ type: "exit", code: lastCode, ts: Date.now() }) + "\n");
      controller.close();
    },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/lib/operations/run-sync.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/operations/run-sync.ts src/lib/operations/merge-streams.ts tests/lib/operations/run-sync.test.ts
git commit -m "feat(scheduler): extract runSync operation core"
```

### Task 5: Refactor the pull route to use `runSync`

**Files:**
- Modify: `src/app/api/pull/route.ts` (replace the entire POST body with a thin adapter)

- [ ] **Step 1: Replace the route body**

Replace the whole file with:

```ts
import { NextRequest } from "next/server";
import { ConfigScope } from "@/lib/fr-config";
import { runSync } from "@/lib/operations/run-sync";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { environment, scopes } = body as { environment: string; scopes?: ConfigScope[] };
  if (!environment) return new Response("Missing environment", { status: 400 });

  const stream = new ReadableStream<string>({
    async start(controller) {
      const emit = (evt: object) => controller.enqueue(JSON.stringify(evt) + "\n");
      const result = await runSync({ environment, scopes, trigger: "manual" }, emit);
      emit({ type: "exit", code: result.status === "success" ? 0 : 1, ts: Date.now() });
      controller.close();
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
```

- [ ] **Step 2: Run the existing pull-related tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / no new type errors. (If a test asserted the exact ordering of `pre-pull-*` then runner output then `post-pull-*`, that ordering is preserved because `runSync` emits in the same sequence.)

- [ ] **Step 3: Manual smoke check**

Run: `npm run dev` then, from another shell, trigger a pull via the existing Sync UI against a test environment and confirm the streamed log looks identical to before (pre-pull commit/prune events, scope output, post-pull commit, exit).
Expected: behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/pull/route.ts
git commit -m "refactor(scheduler): pull route delegates to runSync core"
```

### Task 6: Extract `runGitPush` core from the git/push route

The `api/git/push/route.ts` POST does preflight → `git add` → `git commit` → `git push --force-with-lease?` against the whole environments repo (`cwd = resolveTargetDir()`). Extract the add/commit/push sequence (not the streaming/preflight HTTP specifics) into `runGitPush`.

**Files:**
- Create: `src/lib/operations/run-git-push.ts`
- Test: `tests/lib/operations/run-git-push.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/operations/run-git-push.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runGit = vi.fn();
vi.mock("@/lib/git-settings", () => ({
  loadSettings: () => ({ targetDir: "/repo", branch: "main", remoteUrl: "git@x:y.git" }),
  resolveTargetDir: () => "/repo",
  targetHasGit: () => true,
  runGit: (...a: unknown[]) => runGit(...a),
}));
vi.mock("@/lib/op-history", () => ({ appendOpLog: vi.fn(() => ({ id: "op-2" })) }));

describe("runGitPush", () => {
  beforeEach(() => { runGit.mockReset(); });

  it("commits and pushes when the repo is dirty", async () => {
    // status --porcelain (dirty) → add → commit → push, each returns ok.
    runGit
      .mockReturnValueOnce({ code: 0, stdout: " M a\n", stderr: "" }) // status
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" })        // add
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" })        // commit
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" });       // push
    const { runGitPush } = await import("@/lib/operations/run-git-push");
    const result = await runGitPush({ message: "scheduled sync" }, () => {});
    expect(result.status).toBe("success");
    const argvs = runGit.mock.calls.map((c) => (c[0] as string[]).join(" "));
    expect(argvs.some((a) => a.startsWith("commit"))).toBe(true);
    expect(argvs.some((a) => a.startsWith("push"))).toBe(true);
  });

  it("returns success without committing when the tree is clean", async () => {
    runGit
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" })  // status clean
      .mockReturnValueOnce({ code: 0, stdout: "", stderr: "" }); // push (in case there are unpushed commits)
    const { runGitPush } = await import("@/lib/operations/run-git-push");
    const result = await runGitPush({ message: "noop" }, () => {});
    expect(result.status).toBe("success");
    const argvs = runGit.mock.calls.map((c) => (c[0] as string[]).join(" "));
    expect(argvs.some((a) => a.startsWith("commit"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/operations/run-git-push.test.ts`
Expected: FAIL — "Cannot find module '@/lib/operations/run-git-push'".

- [ ] **Step 3: Implement the core**

```ts
// src/lib/operations/run-git-push.ts
import { loadSettings, resolveTargetDir, targetHasGit, runGit } from "@/lib/git-settings";
import { appendOpLog } from "@/lib/op-history";
import type { OpEventSink, OpResult } from "@/lib/operations/types";

export interface RunGitPushOpts {
  message?: string;
  force?: boolean;
  trigger?: "manual" | "scheduled";
  scheduleId?: string;
}

export async function runGitPush(opts: RunGitPushOpts, emit: OpEventSink): Promise<OpResult> {
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();
  const settings = loadSettings();

  const finish = (status: "success" | "failed", summary: string, error?: string): OpResult => {
    let runId: string | undefined;
    try {
      runId = appendOpLog({ type: "push", environment: "(repo)", scopes: [], status, startedAt, durationMs: Date.now() - startTime, summary, trigger: opts.trigger, scheduleId: opts.scheduleId }).id;
    } catch { /* non-fatal */ }
    return { status, summary, durationMs: Date.now() - startTime, error, runId };
  };

  if (!targetHasGit(settings)) {
    emit({ type: "git", action: "push-error", message: "Target directory is not a git repository", ts: Date.now() });
    return finish("failed", "Not a git repository", "Target directory is not a git repository");
  }

  const cwd = resolveTargetDir(settings);
  const branch = settings.branch || "main";

  // Stage + commit only when dirty.
  const status = runGit(["status", "--porcelain"], cwd);
  const dirty = status.code === 0 && status.stdout.trim().length > 0;
  if (dirty) {
    const add = runGit(["add", "-A"], cwd);
    if (add.code !== 0) { emit({ type: "git", action: "add-error", message: add.stderr, ts: Date.now() }); return finish("failed", "git add failed", add.stderr); }
    const message = opts.message ?? `chore(scheduler): scheduled commit @ ${startedAt}`;
    const commit = runGit(["commit", "-m", message], cwd);
    if (commit.code !== 0) { emit({ type: "git", action: "commit-error", message: commit.stderr, ts: Date.now() }); return finish("failed", "git commit failed", commit.stderr); }
    emit({ type: "git", action: "commit", message: `Committed: ${message}`, ts: Date.now() });
  } else {
    emit({ type: "git", action: "clean", message: "Working tree clean — nothing to commit", ts: Date.now() });
  }

  const pushArgs = ["push", ...(opts.force ? ["--force-with-lease"] : []), "origin", branch];
  const push = runGit(pushArgs, cwd);
  if (push.code !== 0) {
    emit({ type: "git", action: "push-error", message: push.stderr, ts: Date.now() });
    return finish("failed", "git push failed", push.stderr);
  }
  emit({ type: "git", action: "push", message: `Pushed to origin/${branch}`, ts: Date.now() });
  return finish("success", dirty ? "Committed and pushed" : "Pushed (no new commit)");
}
```

> NOTE: confirm `runGit`'s return shape is `{ code, stdout, stderr }` by reading `src/lib/git-settings.ts:72` (`runGit` / `RunResult`). If the property is named `status`/`exitCode` instead of `code`, adjust the `.code` reads here and in the test to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/operations/run-git-push.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/operations/run-git-push.ts tests/lib/operations/run-git-push.test.ts
git commit -m "feat(scheduler): extract runGitPush operation core"
```

### Task 7: `runDataPull` core (job kickoff + await)

The data-pull route starts a registry job and runs `runPull(...)` in the background, returning `202` with a `jobId`. For the scheduler we want a core that starts the job and **awaits** it, returning an `OpResult`.

**Files:**
- Create: `src/lib/operations/run-data-pull.ts`
- Test: `tests/lib/operations/run-data-pull.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/operations/run-data-pull.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const startJob = vi.fn(() => ({ id: "job-1", status: "running" }));
const getJob = vi.fn(() => ({ id: "job-1", status: "completed" }));
const runPull = vi.fn(async () => {});
vi.mock("@/lib/data/job-registry", () => ({
  getRegistry: () => ({ startJob, getJob }),
  JobConflictError: class JobConflictError extends Error {},
}));
vi.mock("@/lib/data/pull-runner", () => ({ runPull: (...a: unknown[]) => runPull(...a) }));
vi.mock("@/lib/iga-api", () => ({ getAccessToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/fr-config", () => ({ getEnvironments: () => [{ name: "dev", pageSize: 100 }] }));
vi.mock("@/lib/op-history", () => ({ appendOpLog: vi.fn(() => ({ id: "op-3" })) }));

describe("runDataPull", () => {
  beforeEach(() => { startJob.mockClear(); runPull.mockClear(); });

  it("starts a job, awaits the runner, and reports success", async () => {
    const { runDataPull } = await import("@/lib/operations/run-data-pull");
    const result = await runDataPull({ environment: "dev", managedObjects: ["alpha_user"], envVars: { ORIGIN_AM: "x" } }, () => {});
    expect(startJob).toHaveBeenCalledWith("dev", ["alpha_user"]);
    expect(runPull).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/operations/run-data-pull.test.ts`
Expected: FAIL — "Cannot find module '@/lib/operations/run-data-pull'".

- [ ] **Step 3: Implement the core**

```ts
// src/lib/operations/run-data-pull.ts
import { getRegistry } from "@/lib/data/job-registry";
import { runPull } from "@/lib/data/pull-runner";
import { getAccessToken } from "@/lib/iga-api";
import { getEnvironments } from "@/lib/fr-config";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { appendOpLog } from "@/lib/op-history";
import type { OpEventSink, OpResult } from "@/lib/operations/types";

export interface RunDataPullOpts {
  environment: string;
  managedObjects: string[];
  /** Parsed .env vars for the environment (the route reads these from disk). */
  envVars: Record<string, string>;
  trigger?: "manual" | "scheduled";
  scheduleId?: string;
}

export async function runDataPull(opts: RunDataPullOpts, emit: OpEventSink): Promise<OpResult> {
  const { environment, managedObjects, envVars } = opts;
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  const envMeta = getEnvironments().find((e) => e.name === environment);
  const pageSize = typeof envMeta?.pageSize === "number" && envMeta.pageSize > 0 ? envMeta.pageSize : undefined;

  const registry = getRegistry();
  const job = registry.startJob(environment, managedObjects);
  emit({ type: "data", action: "job-start", jobId: job.id, ts: Date.now() });

  const controller = new AbortController();
  let error: string | undefined;
  try {
    await runPull({ job, registry, envsRoot: ENVIRONMENTS_DIR, envVars, mintToken: (vars) => getAccessToken(vars), signal: controller.signal, pageSize });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const finalJob = registry.getJob(job.id);
  const ok = !error && finalJob?.status === "completed";
  const summary = ok
    ? `Data pull complete for ${managedObjects.length} type${managedObjects.length !== 1 ? "s" : ""}`
    : `Data pull ${finalJob?.status ?? "failed"}${error ? `: ${error}` : ""}`;

  let runId: string | undefined;
  try {
    runId = appendOpLog({ type: "pull", environment, scopes: managedObjects, status: ok ? "success" : "failed", startedAt, durationMs: Date.now() - startTime, summary, trigger: opts.trigger, scheduleId: opts.scheduleId }).id;
  } catch { /* non-fatal */ }

  emit({ type: "data", action: "job-end", jobId: job.id, status: finalJob?.status, ts: Date.now() });
  return { status: ok ? "success" : "failed", summary, durationMs: Date.now() - startTime, runId, error };
}
```

> NOTE: confirm `runPull`'s argument object keys against `src/lib/data/pull-runner.ts` (the route at `api/data/pull/route.ts:62-70` passes `{ job, registry, envsRoot, envVars, mintToken, signal, pageSize }` — mirror exactly). Confirm `OpType` includes a value appropriate for data pulls; if a distinct `"data-pull"` type is wanted, add it to `OpType` in `op-history.ts` first. This plan reuses `"pull"` to avoid touching the History UI's type filter.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/operations/run-data-pull.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/operations/run-data-pull.ts tests/lib/operations/run-data-pull.test.ts
git commit -m "feat(scheduler): runDataPull operation core (kickoff + await)"
```

---

## Phase 2: Schedule model, store, and cron math

### Task 8: Schedule types

**Files:**
- Create: `src/lib/scheduler/types.ts`

- [ ] **Step 1: Create the types**

```ts
// src/lib/scheduler/types.ts
import type { ConfigScope } from "@/lib/fr-config";

export interface SyncStep { type: "sync"; environment: string; scopes: ConfigScope[]; }
export interface PullDataStep { type: "pull-data"; environment: string; managedObjects: string[]; }
export interface GitPushStep { type: "git-push"; message?: string; force?: boolean; }
export type Step = SyncStep | PullDataStep | GitPushStep;

export type Preset =
  | { every: "hour"; minute: number }
  | { every: "day"; time: string }            // "HH:mm"
  | { every: "week"; days: number[]; time: string }; // days: 0-6 (Sun=0)

export interface Trigger {
  kind: "preset" | "cron";
  preset?: Preset;
  cron?: string;
  timezone: string; // IANA tz
}

export interface ScheduleRunRef {
  at: string;
  status: "success" | "failed" | "partial" | "skipped-overlap";
  runId?: string;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  onError: "stop" | "continue";
  catchUpIfMissed: boolean;
  lastRun?: ScheduleRunRef;
  nextRunAt: string;   // ISO
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may send when creating/updating; server fills the rest. */
export interface ScheduleInput {
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  onError: "stop" | "continue";
  catchUpIfMissed: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/scheduler/types.ts
git commit -m "feat(scheduler): schedule data model types"
```

### Task 9: Cron utilities (`presetToCron`, `computeNextRun`)

**Files:**
- Create: `src/lib/scheduler/cron.ts`
- Test: `tests/lib/scheduler/cron.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/scheduler/cron.test.ts
import { describe, it, expect } from "vitest";
import { presetToCron, computeNextRun } from "@/lib/scheduler/cron";
import type { Trigger } from "@/lib/scheduler/types";

describe("presetToCron", () => {
  it("hourly at minute 30", () => {
    expect(presetToCron({ every: "hour", minute: 30 })).toBe("30 * * * *");
  });
  it("daily at 02:15", () => {
    expect(presetToCron({ every: "day", time: "02:15" })).toBe("15 2 * * *");
  });
  it("weekly Mon+Wed at 09:00", () => {
    expect(presetToCron({ every: "week", days: [1, 3], time: "09:00" })).toBe("0 9 * * 1,3");
  });
});

describe("computeNextRun", () => {
  it("computes the next daily run after a fixed instant (UTC)", () => {
    const trig: Trigger = { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" };
    const from = new Date("2026-06-16T03:00:00Z"); // already past 02:00 today
    const next = computeNextRun(trig, from);
    expect(next).toBe("2026-06-17T02:00:00.000Z");
  });

  it("honors an explicit cron expression", () => {
    const trig: Trigger = { kind: "cron", cron: "0 0 * * *", timezone: "UTC" };
    const from = new Date("2026-06-16T05:00:00Z");
    expect(computeNextRun(trig, from)).toBe("2026-06-17T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/scheduler/cron.test.ts`
Expected: FAIL — "Cannot find module '@/lib/scheduler/cron'".

- [ ] **Step 3: Implement**

```ts
// src/lib/scheduler/cron.ts
import { CronExpressionParser } from "cron-parser";
import type { Preset, Trigger } from "@/lib/scheduler/types";

export function presetToCron(p: Preset): string {
  if (p.every === "hour") return `${p.minute} * * * *`;
  const [hh, mm] = p.time.split(":").map((s) => parseInt(s, 10));
  if (p.every === "day") return `${mm} ${hh} * * *`;
  // week
  const days = [...p.days].sort((a, b) => a - b).join(",");
  return `${mm} ${hh} * * ${days}`;
}

export function triggerToCron(t: Trigger): string {
  if (t.kind === "cron") {
    if (!t.cron) throw new Error("cron trigger missing cron expression");
    return t.cron;
  }
  if (!t.preset) throw new Error("preset trigger missing preset");
  return presetToCron(t.preset);
}

/** Next fire time strictly after `from`, as an ISO string. Throws on a bad cron. */
export function computeNextRun(t: Trigger, from: Date): string {
  const expr = triggerToCron(t);
  const interval = CronExpressionParser.parse(expr, { currentDate: from, tz: t.timezone });
  return interval.next().toDate().toISOString();
}

/** Validate a trigger; returns an error message or null. */
export function validateTrigger(t: Trigger): string | null {
  try { computeNextRun(t, new Date(0)); return null; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/scheduler/cron.test.ts`
Expected: PASS. If `computeNextRun` returns a value off by the timezone, confirm cron-parser's `tz` option name for the installed version (v4 uses `tz`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler/cron.ts tests/lib/scheduler/cron.test.ts
git commit -m "feat(scheduler): preset->cron and next-run computation"
```

### Task 10: Schedule store (`schedules.json` CRUD)

**Files:**
- Create: `src/lib/scheduler/store.ts`
- Test: `tests/lib/scheduler/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/scheduler/store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("schedule store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
    process.env.PINGHUB_DATA_DIR = dir;
    vi.resetModules();
  });
  afterEach(() => { delete process.env.PINGHUB_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it("create → list → get → update → delete round-trips", async () => {
    const store = await import("@/lib/scheduler/store");
    const now = new Date("2026-06-16T00:00:00Z");
    const created = store.createSchedule({
      name: "nightly", enabled: true,
      trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
      steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true,
    }, now);

    expect(created.id).toBeTruthy();
    expect(created.nextRunAt).toBe("2026-06-16T02:00:00.000Z");
    expect(store.listSchedules()).toHaveLength(1);

    const updated = store.updateSchedule(created.id, { name: "renamed" }, now);
    expect(updated?.name).toBe("renamed");
    expect(store.getSchedule(created.id)?.name).toBe("renamed");

    store.deleteSchedule(created.id);
    expect(store.listSchedules()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/scheduler/store.test.ts`
Expected: FAIL — "Cannot find module '@/lib/scheduler/store'".

- [ ] **Step 3: Implement**

```ts
// src/lib/scheduler/store.ts
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { computeNextRun } from "@/lib/scheduler/cron";
import type { Schedule, ScheduleInput, ScheduleRunRef } from "@/lib/scheduler/types";

const FILE = path.join(ENVIRONMENTS_DIR, "schedules.json");

function readAll(): Schedule[] {
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.schedules) ? parsed.schedules : [];
  } catch { return []; }
}

function writeAll(schedules: Schedule[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schedules }, null, 2), "utf-8");
  fs.renameSync(tmp, FILE); // atomic replace
}

export function listSchedules(): Schedule[] { return readAll(); }
export function getSchedule(id: string): Schedule | null { return readAll().find((s) => s.id === id) ?? null; }

export function createSchedule(input: ScheduleInput, now: Date = new Date()): Schedule {
  const iso = now.toISOString();
  const schedule: Schedule = {
    id: randomUUID(),
    ...input,
    nextRunAt: computeNextRun(input.trigger, now),
    createdAt: iso,
    updatedAt: iso,
  };
  const all = readAll();
  all.push(schedule);
  writeAll(all);
  return schedule;
}

export function updateSchedule(id: string, patch: Partial<ScheduleInput>, now: Date = new Date()): Schedule | null {
  const all = readAll();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const merged: Schedule = { ...all[idx], ...patch, updatedAt: now.toISOString() };
  // Recompute nextRunAt if the trigger changed.
  if (patch.trigger) merged.nextRunAt = computeNextRun(merged.trigger, now);
  all[idx] = merged;
  writeAll(all);
  return merged;
}

/** Persist run outcome + the next fire time. Used by the engine. */
export function recordRun(id: string, lastRun: ScheduleRunRef, nextRunAt: string): void {
  const all = readAll();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) return;
  all[idx] = { ...all[idx], lastRun, nextRunAt };
  writeAll(all);
}

export function deleteSchedule(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/scheduler/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler/store.ts tests/lib/scheduler/store.test.ts
git commit -m "feat(scheduler): schedules.json store with atomic writes"
```

---

## Phase 3: Scheduler engine

### Task 11: Step runner (dispatch one Step to its core)

**Files:**
- Create: `src/lib/scheduler/run-step.ts`
- Test: `tests/lib/scheduler/run-step.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/scheduler/run-step.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runSync = vi.fn(async () => ({ status: "success", summary: "ok", durationMs: 1 }));
const runGitPush = vi.fn(async () => ({ status: "success", summary: "pushed", durationMs: 1 }));
const runDataPull = vi.fn(async () => ({ status: "success", summary: "data", durationMs: 1 }));
vi.mock("@/lib/operations/run-sync", () => ({ runSync }));
vi.mock("@/lib/operations/run-git-push", () => ({ runGitPush }));
vi.mock("@/lib/operations/run-data-pull", () => ({ runDataPull }));
vi.mock("@/lib/scheduler/env-vars", () => ({ readEnvVars: () => ({ ORIGIN_AM: "x" }) }));

describe("runStep", () => {
  beforeEach(() => { runSync.mockClear(); runGitPush.mockClear(); runDataPull.mockClear(); });

  it("dispatches a sync step to runSync with scheduled trigger", async () => {
    const { runStep } = await import("@/lib/scheduler/run-step");
    const r = await runStep({ type: "sync", environment: "dev", scopes: ["journeys"] }, "sched-1", () => {});
    expect(runSync).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "dev", scopes: ["journeys"], trigger: "scheduled", scheduleId: "sched-1" }),
      expect.any(Function),
    );
    expect(r.status).toBe("success");
  });

  it("dispatches a git-push step to runGitPush", async () => {
    const { runStep } = await import("@/lib/scheduler/run-step");
    await runStep({ type: "git-push", message: "m" }, "sched-1", () => {});
    expect(runGitPush).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/scheduler/run-step.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the env-vars helper and the step runner**

```ts
// src/lib/scheduler/env-vars.ts
import fs from "fs";
import path from "path";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { parseEnvFile } from "@/lib/env-parser";

/** Read and parse <env>/.env. Returns {} if missing. */
export function readEnvVars(environment: string): Record<string, string> {
  const f = path.join(ENVIRONMENTS_DIR, environment, ".env");
  if (!fs.existsSync(f)) return {};
  return parseEnvFile(fs.readFileSync(f, "utf-8")) as Record<string, string>;
}
```

```ts
// src/lib/scheduler/run-step.ts
import { runSync } from "@/lib/operations/run-sync";
import { runGitPush } from "@/lib/operations/run-git-push";
import { runDataPull } from "@/lib/operations/run-data-pull";
import { readEnvVars } from "@/lib/scheduler/env-vars";
import type { Step } from "@/lib/scheduler/types";
import type { OpEventSink, OpResult } from "@/lib/operations/types";

export async function runStep(step: Step, scheduleId: string, emit: OpEventSink): Promise<OpResult> {
  switch (step.type) {
    case "sync":
      return runSync({ environment: step.environment, scopes: step.scopes, trigger: "scheduled", scheduleId }, emit);
    case "pull-data":
      return runDataPull({ environment: step.environment, managedObjects: step.managedObjects, envVars: readEnvVars(step.environment), trigger: "scheduled", scheduleId }, emit);
    case "git-push":
      return runGitPush({ message: step.message, force: step.force, trigger: "scheduled", scheduleId }, emit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/scheduler/run-step.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler/run-step.ts src/lib/scheduler/env-vars.ts tests/lib/scheduler/run-step.test.ts
git commit -m "feat(scheduler): per-step dispatch to operation cores"
```

### Task 12: Engine — `runSchedule` (pipeline execution + overlap lock + history)

**Files:**
- Create: `src/lib/scheduler/engine.ts`
- Test: `tests/lib/scheduler/engine-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/scheduler/engine-run.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordRun = vi.fn();
const getSchedule = vi.fn();
vi.mock("@/lib/scheduler/store", () => ({
  getSchedule, recordRun, listSchedules: vi.fn(() => []),
}));
const runStep = vi.fn();
vi.mock("@/lib/scheduler/run-step", () => ({ runStep }));
vi.mock("@/lib/scheduler/cron", () => ({ computeNextRun: () => "2026-06-17T02:00:00.000Z" }));

const baseSchedule = {
  id: "s1", name: "n", enabled: true,
  trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
  onError: "stop", catchUpIfMissed: true,
  nextRunAt: "2026-06-16T02:00:00.000Z", createdAt: "", updatedAt: "",
  steps: [{ type: "git-push" }, { type: "git-push" }],
};

describe("runSchedule", () => {
  beforeEach(() => { recordRun.mockClear(); runStep.mockClear(); getSchedule.mockReset(); });

  it("runs all steps and records success", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule });
    runStep.mockResolvedValue({ status: "success", summary: "ok", durationMs: 1, runId: "op-1" });
    const { runSchedule } = await import("@/lib/scheduler/engine");
    await runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "success" }), expect.any(String));
  });

  it("stops after a failing step when onError=stop and records failed", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule, onError: "stop" });
    runStep
      .mockResolvedValueOnce({ status: "failed", summary: "bad", durationMs: 1 })
      .mockResolvedValueOnce({ status: "success", summary: "ok", durationMs: 1 });
    const { runSchedule } = await import("@/lib/scheduler/engine");
    await runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    expect(runStep).toHaveBeenCalledTimes(1); // stopped early
    expect(recordRun).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "failed" }), expect.any(String));
  });

  it("skips a re-entrant run while one is in flight (overlap lock)", async () => {
    getSchedule.mockReturnValue({ ...baseSchedule });
    let resolveStep: (v: unknown) => void = () => {};
    runStep.mockImplementation(() => new Promise((res) => { resolveStep = res; }));
    const { runSchedule } = await import("@/lib/scheduler/engine");
    const first = runSchedule("s1", new Date("2026-06-16T02:00:05Z"));
    const second = await runSchedule("s1", new Date("2026-06-16T02:00:06Z")); // returns immediately
    expect(second).toBe("skipped-overlap");
    resolveStep({ status: "success", summary: "ok", durationMs: 1 });
    await first;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/scheduler/engine-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runSchedule` (engine.ts, first half)**

```ts
// src/lib/scheduler/engine.ts
import { getSchedule, listSchedules, recordRun } from "@/lib/scheduler/store";
import { runStep } from "@/lib/scheduler/run-step";
import { computeNextRun } from "@/lib/scheduler/cron";
import { NOOP_SINK } from "@/lib/operations/types";
import type { ScheduleRunRef } from "@/lib/scheduler/types";

/** In-memory set of schedule IDs with a run currently in flight. */
const inFlight = new Set<string>();

/** Run one schedule now. Returns the resulting run status (or "skipped-overlap"). */
export async function runSchedule(id: string, now: Date = new Date()): Promise<ScheduleRunRef["status"]> {
  if (inFlight.has(id)) return "skipped-overlap";
  const schedule = getSchedule(id);
  if (!schedule) return "failed";

  inFlight.add(id);
  try {
    let anyFailed = false;
    let stopped = false;
    for (const step of schedule.steps) {
      const result = await runStep(step, id, NOOP_SINK);
      if (result.status === "failed") {
        anyFailed = true;
        if (schedule.onError === "stop") { stopped = true; break; }
      }
    }
    const status: ScheduleRunRef["status"] = !anyFailed ? "success" : stopped ? "failed" : "partial";
    const lastRun: ScheduleRunRef = { at: now.toISOString(), status };
    const nextRunAt = computeNextRun(schedule.trigger, now);
    recordRun(id, lastRun, nextRunAt);
    return status;
  } finally {
    inFlight.delete(id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/scheduler/engine-run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler/engine.ts tests/lib/scheduler/engine-run.test.ts
git commit -m "feat(scheduler): runSchedule pipeline execution with overlap lock"
```

### Task 13: Engine — `tick`, `startScheduler`, `stopScheduler`, catch-up

**Files:**
- Modify: `src/lib/scheduler/engine.ts`
- Test: `tests/lib/scheduler/engine-tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/scheduler/engine-tick.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const listSchedules = vi.fn();
const getSchedule = vi.fn((id) => listSchedules().find((s: { id: string }) => s.id === id));
const recordRun = vi.fn();
vi.mock("@/lib/scheduler/store", () => ({ listSchedules, getSchedule, recordRun }));
const runStep = vi.fn(async () => ({ status: "success", summary: "ok", durationMs: 1 }));
vi.mock("@/lib/scheduler/run-step", () => ({ runStep }));
vi.mock("@/lib/scheduler/cron", () => ({ computeNextRun: () => "2999-01-01T00:00:00.000Z" }));

function sched(over: Record<string, unknown>) {
  return { id: "s1", name: "n", enabled: true, onError: "stop", catchUpIfMissed: true,
    trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
    steps: [{ type: "git-push" }], nextRunAt: "2026-06-16T02:00:00.000Z",
    createdAt: "", updatedAt: "", ...over };
}

describe("tick", () => {
  beforeEach(() => { runStep.mockClear(); recordRun.mockClear(); });

  it("fires a due, enabled schedule", async () => {
    listSchedules.mockReturnValue([sched({ nextRunAt: "2026-06-16T01:59:00.000Z" })]);
    const { tick } = await import("@/lib/scheduler/engine");
    await tick(new Date("2026-06-16T02:00:30Z"));
    expect(runStep).toHaveBeenCalledTimes(1);
  });

  it("does not fire a schedule whose nextRunAt is in the future", async () => {
    listSchedules.mockReturnValue([sched({ nextRunAt: "2026-06-16T03:00:00.000Z" })]);
    const { tick } = await import("@/lib/scheduler/engine");
    await tick(new Date("2026-06-16T02:00:30Z"));
    expect(runStep).not.toHaveBeenCalled();
  });

  it("does not fire a disabled schedule", async () => {
    listSchedules.mockReturnValue([sched({ enabled: false, nextRunAt: "2026-06-16T01:00:00.000Z" })]);
    const { tick } = await import("@/lib/scheduler/engine");
    await tick(new Date("2026-06-16T02:00:30Z"));
    expect(runStep).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/scheduler/engine-tick.test.ts`
Expected: FAIL — `tick` is not exported.

- [ ] **Step 3: Append `tick` / `startScheduler` / `stopScheduler` to engine.ts**

Add to the bottom of `src/lib/scheduler/engine.ts`:

```ts
/** Fire every enabled schedule whose nextRunAt <= now. */
export async function tick(now: Date = new Date()): Promise<void> {
  let schedules;
  try { schedules = listSchedules(); } catch { return; }
  for (const s of schedules) {
    if (!s.enabled) continue;
    if (new Date(s.nextRunAt).getTime() > now.getTime()) continue;
    try { await runSchedule(s.id, now); } catch { /* engine never crashes on one schedule */ }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 60_000;

/** Start the tick loop. Idempotent. On boot, runs an immediate catch-up tick. */
export function startScheduler(): void {
  if (timer) return;
  // Catch-up: an immediate tick runs any schedule already past-due. runSchedule
  // recomputes nextRunAt forward, so each missed schedule fires at most once.
  void tick().catch(() => {});
  timer = setInterval(() => { void tick().catch(() => {}); }, TICK_MS);
  // Don't keep the process alive solely for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
```

> NOTE on catch-up: a schedule with `catchUpIfMissed: false` whose `nextRunAt` is in
> the past should be rolled forward WITHOUT running. Implement this by having the
> boot path special-case it: see Task 14 Step 3, where `startScheduler` is wrapped to
> first roll forward past-due non-catch-up schedules before the first `tick()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/scheduler/engine-tick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler/engine.ts tests/lib/scheduler/engine-tick.test.ts
git commit -m "feat(scheduler): tick loop with start/stop and boot catch-up"
```

### Task 14: Boot catch-up roll-forward + `instrumentation.ts`

**Files:**
- Modify: `src/lib/scheduler/engine.ts` (add `rollForwardSkipped`)
- Create: `src/instrumentation.ts`
- Test: `tests/lib/scheduler/engine-catchup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/scheduler/engine-catchup.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const listSchedules = vi.fn();
const recordRun = vi.fn();
const getSchedule = vi.fn();
vi.mock("@/lib/scheduler/store", () => ({ listSchedules, getSchedule, recordRun }));
vi.mock("@/lib/scheduler/run-step", () => ({ runStep: vi.fn() }));
vi.mock("@/lib/scheduler/cron", () => ({ computeNextRun: () => "2999-01-01T00:00:00.000Z" }));

describe("rollForwardSkipped", () => {
  beforeEach(() => { recordRun.mockClear(); });

  it("rolls a past-due non-catch-up schedule forward without running it", async () => {
    listSchedules.mockReturnValue([{
      id: "s1", enabled: true, catchUpIfMissed: false,
      trigger: { kind: "cron", cron: "0 0 * * *", timezone: "UTC" },
      steps: [], onError: "stop", name: "n",
      nextRunAt: "2020-01-01T00:00:00.000Z", createdAt: "", updatedAt: "",
    }]);
    const { rollForwardSkipped } = await import("@/lib/scheduler/engine");
    rollForwardSkipped(new Date("2026-06-16T00:00:00Z"));
    expect(recordRun).toHaveBeenCalledWith("s1",
      expect.objectContaining({ status: "skipped-overlap" }), "2999-01-01T00:00:00.000Z");
  });
});
```

(Reuses the `skipped-overlap` status to mean "rolled past without running"; acceptable since the History badge treats both as "not run".)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/scheduler/engine-catchup.test.ts`
Expected: FAIL — `rollForwardSkipped` not exported.

- [ ] **Step 3: Implement `rollForwardSkipped` and wire it into `startScheduler`**

Add to `src/lib/scheduler/engine.ts`:

```ts
/** Roll past-due schedules with catchUpIfMissed=false forward to their next fire,
 *  recording a skipped marker, so the boot tick doesn't run stale schedules. */
export function rollForwardSkipped(now: Date = new Date()): void {
  let schedules;
  try { schedules = listSchedules(); } catch { return; }
  for (const s of schedules) {
    if (!s.enabled || s.catchUpIfMissed) continue;
    if (new Date(s.nextRunAt).getTime() > now.getTime()) continue;
    try { recordRun(s.id, { at: now.toISOString(), status: "skipped-overlap" }, computeNextRun(s.trigger, now)); }
    catch { /* ignore */ }
  }
}
```

Then change `startScheduler` so the first line of its body is:

```ts
  rollForwardSkipped();
```

(placed before the catch-up `tick()` call).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/scheduler/engine-catchup.test.ts`
Expected: PASS

- [ ] **Step 5: Create the instrumentation hook**

```ts
// src/instrumentation.ts
/** Next.js calls register() once per server process at startup. */
export async function register() {
  // Only run in the Node.js server runtime (not Edge, not during build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("@/lib/scheduler/engine");
  startScheduler();
}
```

- [ ] **Step 6: Enable the instrumentation hook if needed**

Check `next.config.*`. Next 16 runs `instrumentation.ts` by default; if an older flag is present, ensure `experimental.instrumentationHook` is not set to `false`. No change needed if absent.

Run: `npm run dev` and confirm the server logs no errors and that the scheduler tick starts (add a temporary `console.log("scheduler started")` in `startScheduler`, verify, then remove it).
Expected: server boots; hook runs once.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scheduler/engine.ts src/instrumentation.ts tests/lib/scheduler/engine-catchup.test.ts
git commit -m "feat(scheduler): boot catch-up roll-forward + instrumentation hook"
```

---

## Phase 4: API routes

### Task 15: `/api/schedules` — list + create

**Files:**
- Create: `src/app/api/schedules/route.ts`
- Test: `tests/api/schedules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/schedules.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("/api/schedules", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedapi-")); process.env.PINGHUB_DATA_DIR = dir; vi.resetModules(); });
  afterEach(() => { delete process.env.PINGHUB_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it("POST creates and GET lists", async () => {
    const { POST, GET } = await import("@/app/api/schedules/route");
    const body = { name: "nightly", enabled: true,
      trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
      steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true };
    const created = await (await POST(new Request("http://x/api/schedules", { method: "POST", body: JSON.stringify(body) }))).json();
    expect(created.id).toBeTruthy();
    const list = await (await GET()).json();
    expect(list).toHaveLength(1);
  });

  it("POST rejects an invalid cron with 400", async () => {
    const { POST } = await import("@/app/api/schedules/route");
    const body = { name: "bad", enabled: true,
      trigger: { kind: "cron", cron: "not a cron", timezone: "UTC" },
      steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true };
    const res = await POST(new Request("http://x/api/schedules", { method: "POST", body: JSON.stringify(body) }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/schedules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/schedules/route.ts
import { NextResponse } from "next/server";
import { listSchedules, createSchedule } from "@/lib/scheduler/store";
import { validateTrigger } from "@/lib/scheduler/cron";
import type { ScheduleInput } from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listSchedules());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ScheduleInput | null;
  if (!body || !body.name || !Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json({ error: "name and at least one step are required" }, { status: 400 });
  }
  const triggerErr = validateTrigger(body.trigger);
  if (triggerErr) return NextResponse.json({ error: `Invalid trigger: ${triggerErr}` }, { status: 400 });
  const created = createSchedule(body);
  return NextResponse.json(created, { status: 201 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/schedules.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/schedules/route.ts tests/api/schedules.test.ts
git commit -m "feat(scheduler): /api/schedules list + create"
```

### Task 16: `/api/schedules/[id]` — get / update / delete

**Files:**
- Create: `src/app/api/schedules/[id]/route.ts`
- Test: `tests/api/schedules-id.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/schedules-id.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/schedules/[id]", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedid-")); process.env.PINGHUB_DATA_DIR = dir; vi.resetModules(); });
  afterEach(() => { delete process.env.PINGHUB_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

  it("GET/PUT/DELETE round-trip", async () => {
    const { createSchedule } = await import("@/lib/scheduler/store");
    const s = createSchedule({ name: "n", enabled: true, trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" }, steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true });
    const { GET, PUT, DELETE } = await import("@/app/api/schedules/[id]/route");

    expect((await (await GET(new Request("http://x"), ctx(s.id))).json()).name).toBe("n");
    const put = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ name: "n2" }) }), ctx(s.id));
    expect((await put.json()).name).toBe("n2");
    const del = await DELETE(new Request("http://x", { method: "DELETE" }), ctx(s.id));
    expect(del.status).toBe(200);
    expect((await GET(new Request("http://x"), ctx(s.id))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/schedules-id.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/app/api/schedules/[id]/route.ts
import { NextResponse } from "next/server";
import { getSchedule, updateSchedule, deleteSchedule } from "@/lib/scheduler/store";
import { validateTrigger } from "@/lib/scheduler/cron";
import type { ScheduleInput } from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const s = getSchedule(id);
  return s ? NextResponse.json(s) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const patch = (await req.json().catch(() => ({}))) as Partial<ScheduleInput>;
  if (patch.trigger) {
    const err = validateTrigger(patch.trigger);
    if (err) return NextResponse.json({ error: `Invalid trigger: ${err}` }, { status: 400 });
  }
  const updated = updateSchedule(id, patch);
  return updated ? NextResponse.json(updated) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  deleteSchedule(id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/schedules-id.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/schedules/[id]/route.ts" tests/api/schedules-id.test.ts
git commit -m "feat(scheduler): /api/schedules/[id] get/update/delete"
```

### Task 17: `/api/schedules/[id]/run` — run now

**Files:**
- Create: `src/app/api/schedules/[id]/run/route.ts`
- Test: `tests/api/schedules-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/schedules-run.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runSchedule = vi.fn(async () => "success");
vi.mock("@/lib/scheduler/engine", () => ({ runSchedule }));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/schedules/[id]/run", () => {
  beforeEach(() => runSchedule.mockClear());
  it("invokes runSchedule and returns the status", async () => {
    const { POST } = await import("@/app/api/schedules/[id]/run/route");
    const res = await POST(new Request("http://x", { method: "POST" }), ctx("s1"));
    expect(runSchedule).toHaveBeenCalledWith("s1");
    expect((await res.json()).status).toBe("success");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/schedules-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/app/api/schedules/[id]/run/route.ts
import { NextResponse } from "next/server";
import { runSchedule } from "@/lib/scheduler/engine";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const status = await runSchedule(id);
  return NextResponse.json({ status });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/schedules-run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/schedules/[id]/run/route.ts" tests/api/schedules-run.test.ts
git commit -m "feat(scheduler): /api/schedules/[id]/run run-now endpoint"
```

---

## Phase 5: UI

> UI tasks follow the repo's existing React 19 + Radix + Tailwind patterns. Before writing, read an existing page that lists records and opens a modal editor (e.g. the Sync page `src/app/sync/SyncForm.tsx` and an existing list page) to match component conventions, button styles, and the fetch/error patterns. The steps below give the structure and the data contract; match local styling idioms rather than inventing new ones.

### Task 18: Schedules list page

**Files:**
- Create: `src/app/schedules/page.tsx`
- Create: `src/app/schedules/ScheduleList.tsx`
- Test: `tests/components/ScheduleList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/components/ScheduleList.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScheduleList } from "@/app/schedules/ScheduleList";

describe("ScheduleList", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "s1", name: "Nightly backup", enabled: true,
        trigger: { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: "UTC" },
        steps: [{ type: "git-push" }], onError: "stop", catchUpIfMissed: true,
        nextRunAt: "2026-06-17T02:00:00.000Z", createdAt: "", updatedAt: "" },
    ]))) as unknown as typeof fetch;
  });

  it("renders schedule names from the API", async () => {
    render(<ScheduleList />);
    expect(await screen.findByText("Nightly backup")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/ScheduleList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ScheduleList.tsx`**

```tsx
// src/app/schedules/ScheduleList.tsx
"use client";
import { useEffect, useState, useCallback } from "react";
import type { Schedule } from "@/lib/scheduler/types";

function triggerSummary(s: Schedule): string {
  const t = s.trigger;
  if (t.kind === "cron") return `cron: ${t.cron}`;
  const p = t.preset!;
  if (p.every === "hour") return `Hourly at :${String(p.minute).padStart(2, "0")}`;
  if (p.every === "day") return `Daily ${p.time}`;
  return `Weekly [${p.days.join(",")}] ${p.time}`;
}

export function ScheduleList() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSchedules(await res.json());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const runNow = async (id: string) => { await fetch(`/api/schedules/${id}/run`, { method: "POST" }); void reload(); };
  const toggle = async (s: Schedule) => { await fetch(`/api/schedules/${s.id}`, { method: "PUT", body: JSON.stringify({ enabled: !s.enabled }) }); void reload(); };
  const remove = async (id: string) => { await fetch(`/api/schedules/${id}`, { method: "DELETE" }); void reload(); };

  if (error) return <div className="p-4 text-red-600">Failed to load schedules: {error}</div>;

  return (
    <div className="space-y-2">
      {schedules.length === 0 && <p className="text-muted-foreground">No schedules yet.</p>}
      {schedules.map((s) => (
        <div key={s.id} className="flex items-center justify-between rounded border p-3">
          <div>
            <div className="font-medium">{s.name}</div>
            <div className="text-sm text-muted-foreground">
              {triggerSummary(s)} · next {new Date(s.nextRunAt).toLocaleString()}
              {s.lastRun && <> · last <span className={s.lastRun.status === "success" ? "text-green-600" : s.lastRun.status === "failed" ? "text-red-600" : "text-yellow-600"}>{s.lastRun.status}</span></>}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => toggle(s)} className="text-sm underline">{s.enabled ? "Disable" : "Enable"}</button>
            <button onClick={() => runNow(s.id)} className="text-sm underline">Run now</button>
            <button onClick={() => remove(s.id)} className="text-sm text-red-600 underline">Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement the page wrapper**

```tsx
// src/app/schedules/page.tsx
import { ScheduleList } from "./ScheduleList";

export const dynamic = "force-dynamic";

export default function SchedulesPage() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Schedules</h1>
      <ScheduleList />
    </main>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/components/ScheduleList.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/schedules/page.tsx src/app/schedules/ScheduleList.tsx tests/components/ScheduleList.test.tsx
git commit -m "feat(scheduler): schedules list page"
```

### Task 19: Schedule editor (create/edit) + wire into list

**Files:**
- Create: `src/app/schedules/ScheduleEditor.tsx`
- Modify: `src/app/schedules/ScheduleList.tsx` (add a "New schedule" button + edit hook)
- Test: `tests/components/ScheduleEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/components/ScheduleEditor.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleEditor } from "@/app/schedules/ScheduleEditor";

describe("ScheduleEditor", () => {
  it("POSTs a new schedule on save", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "s9" }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSaved = vi.fn();
    render(<ScheduleEditor onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "My schedule" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/schedules", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/components/ScheduleEditor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ScheduleEditor.tsx`**

Build a controlled form with: name input (`<label>Name</label>`), enabled checkbox, a trigger section (preset tabs Hourly/Daily/Weekly + an "Advanced cron" text field), an `onError` select, a `catchUpIfMissed` checkbox, and a step builder (add/remove rows; each row selects a type then shows the relevant pickers). Reuse the existing environment picker and scope/managed-object pickers from `src/app/sync/SyncForm.tsx` (import and compose them; do not duplicate their option-loading logic).

Minimum viable editor body (extend with the richer pickers once it compiles and the test passes):

```tsx
// src/app/schedules/ScheduleEditor.tsx
"use client";
import { useState } from "react";
import type { ScheduleInput, Step, Trigger } from "@/lib/scheduler/types";

export function ScheduleEditor({ initial, onClose, onSaved }: {
  initial?: ScheduleInput & { id?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [trigger, setTrigger] = useState<Trigger>(initial?.trigger ?? { kind: "preset", preset: { every: "day", time: "02:00" }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [onError, setOnError] = useState<"stop" | "continue">(initial?.onError ?? "stop");
  const [catchUpIfMissed, setCatchUp] = useState(initial?.catchUpIfMissed ?? true);
  const [steps, setSteps] = useState<Step[]>(initial?.steps ?? [{ type: "git-push" }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true); setErr(null);
    const payload: ScheduleInput = { name, enabled, trigger, onError, catchUpIfMissed, steps };
    const url = initial?.id ? `/api/schedules/${initial.id}` : "/api/schedules";
    const method = initial?.id ? "PUT" : "POST";
    const res = await fetch(url, { method, body: JSON.stringify(payload) });
    setSaving(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return; }
    onSaved(); onClose();
  };

  return (
    <div className="space-y-3">
      <label className="block">Name
        <input className="block w-full rounded border p-2" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>

      {/* Trigger: preset vs advanced cron */}
      <fieldset className="rounded border p-3">
        <legend className="text-sm">Trigger</legend>
        <label className="flex items-center gap-2"><input type="radio" checked={trigger.kind === "preset"} onChange={() => setTrigger({ kind: "preset", preset: { every: "day", time: "02:00" }, timezone: trigger.timezone })} /> Preset</label>
        <label className="flex items-center gap-2"><input type="radio" checked={trigger.kind === "cron"} onChange={() => setTrigger({ kind: "cron", cron: "0 2 * * *", timezone: trigger.timezone })} /> Advanced (cron)</label>
        {trigger.kind === "cron" && (
          <input aria-label="cron" className="mt-2 block w-full rounded border p-2 font-mono" value={trigger.cron ?? ""} onChange={(e) => setTrigger({ ...trigger, cron: e.target.value })} />
        )}
        {trigger.kind === "preset" && (
          <input aria-label="daily time" type="time" className="mt-2 rounded border p-2" value={trigger.preset?.every === "day" ? trigger.preset.time : "02:00"} onChange={(e) => setTrigger({ kind: "preset", preset: { every: "day", time: e.target.value }, timezone: trigger.timezone })} />
        )}
      </fieldset>

      {/* Steps — minimal type chooser; extend with env/scope pickers from SyncForm. */}
      <fieldset className="rounded border p-3">
        <legend className="text-sm">Steps</legend>
        {steps.map((s, i) => (
          <div key={i} className="mb-2 flex items-center gap-2">
            <select value={s.type} onChange={(e) => {
              const type = e.target.value as Step["type"];
              const next: Step = type === "sync" ? { type, environment: "", scopes: [] } : type === "pull-data" ? { type, environment: "", managedObjects: [] } : { type: "git-push" };
              setSteps(steps.map((x, j) => (j === i ? next : x)));
            }}>
              <option value="sync">Sync (config pull)</option>
              <option value="pull-data">Pull data</option>
              <option value="git-push">Commit &amp; push</option>
            </select>
            <button type="button" className="text-red-600" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className="text-sm underline" onClick={() => setSteps([...steps, { type: "git-push" }])}>Add step</button>
      </fieldset>

      <label className="block">On step failure
        <select className="block rounded border p-2" value={onError} onChange={(e) => setOnError(e.target.value as "stop" | "continue")}>
          <option value="stop">Stop pipeline</option>
          <option value="continue">Continue</option>
        </select>
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={catchUpIfMissed} onChange={(e) => setCatchUp(e.target.checked)} /> Run once on startup if missed</label>

      {err && <div className="text-red-600">{err}</div>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving} className="rounded bg-blue-600 px-4 py-2 text-white">Save</button>
        <button onClick={onClose} className="rounded border px-4 py-2">Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire a "New schedule" button into `ScheduleList.tsx`**

Add local state `const [editing, setEditing] = useState<null | "new">(null);`, a "New schedule" button that sets it to `"new"`, and conditionally render `<ScheduleEditor onClose={() => setEditing(null)} onSaved={reload} />` (in a Radix `Dialog` matching existing modal usage, or inline for now).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/components/ScheduleEditor.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/schedules/ScheduleEditor.tsx src/app/schedules/ScheduleList.tsx tests/components/ScheduleEditor.test.tsx
git commit -m "feat(scheduler): schedule create/edit editor"
```

### Task 20: Add "Schedules" to navigation

**Files:**
- Modify: the nav/sidebar component (find it: `grep -rl "/sync\"" src/app src/components` — the file linking to other top-level pages)

- [ ] **Step 1: Find the nav component**

Run: `grep -rn "href=\"/sync\"\|href={\`/sync\`}\|\"/logs\"" src/app src/components | head`
Expected: identifies the navigation file and the link pattern used.

- [ ] **Step 2: Add the link**

Add a nav entry pointing to `/schedules` labeled "Schedules", matching the existing entries' markup (icon + label). Use an appropriate `lucide-react` icon already imported elsewhere (e.g. `CalendarClock`).

- [ ] **Step 3: Verify in the running app**

Run: `npm run dev`, open the app, click "Schedules", confirm the page renders and "New schedule" creates one that appears in the list and persists to `<data-dir>/schedules.json`.
Expected: end-to-end create/list/run works.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(scheduler): add Schedules to navigation"
```

---

## Phase 6: Final verification

### Task 21: Full test + typecheck + lint sweep

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run`
Expected: all tests pass (including the pre-existing pull/push tests, proving the core extraction kept behavior).

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: production build succeeds (confirms `instrumentation.ts` and new routes compile under Next's build).

- [ ] **Step 4: Manual end-to-end**

With `npm run dev`: create a pipeline schedule (sync → git-push) with a daily preset set to ~2 minutes ahead; leave the app running; confirm it fires at the scheduled minute, both steps run, the run appears in the existing History view tagged scheduled, and `lastRun` shows on the list. Then disable it.
Expected: full flow works.

- [ ] **Step 5: Final commit (if any sweep fixes were needed)**

```bash
git add -A
git commit -m "chore(scheduler): final test/typecheck/lint sweep"
```

---

## Spec Coverage Check

- Sync / pull-data / git-push task types → Tasks 4, 7, 6 (cores) + 11 (dispatch).
- Single task **and** pipeline → `Schedule.steps[]` (Task 8) + pipeline loop (Task 12).
- Presets **and** advanced cron → Task 9 (`presetToCron`/cron) + editor (Task 19).
- In-process, runs while app up → instrumentation + tick (Tasks 13–14).
- Missed-run catch-up (once) / roll-forward → Tasks 13–14.
- Overlap handling → Task 12 overlap lock.
- Runs in existing History → op-log `trigger`/`scheduleId` (Task 2) used by all cores.
- CRUD + run-now API → Tasks 15–17.
- Schedules UI (list + editor + nav) → Tasks 18–20.
- git-push is whole-repo via `/api/git/push` core → Task 6.
- Defaults (missed once, push to configured remote, 60s tick) → Tasks 13, 6, 13.

## Notes for the implementer

- Three places say **confirm against the real file before coding**: `runGit`'s result shape (Task 6 Step 3), `runPull`'s argument keys (Task 7 Step 3), and `appendOpLog`'s field-copy style (Task 2 Step 4). Read those exact lines first; they're the only points where this plan depends on internals not fully quoted here.
- Keep each core's emitted events identical in name/order to the original route so the browser-facing log is unchanged (verified by the existing pull/push tests in Task 21).
- Data-pull reuses op-type `"pull"`; if you want it visually distinct in History, add a `"data-pull"` value to `OpType` and the History type filter first.
