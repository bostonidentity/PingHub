# AIC Studio M4-M6 — UI Completions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Three small UI completions that polish the surface built in M1-M3:
- **M4 — Compare extras:** add "Compare with revision…" (compare current snapshot against an older snapshot of the same env) and a palette command to pick any two envs and compare a specific journey.
- **M5 — History view:** populate the History sidebar TreeView (currently a placeholder) with operations from `op_history`, grouped by day, with click-to-show-details.
- **M6 — Promotion Tasks polish:** add archived-tasks toggle, batch item removal, view-and-delete actions for archived tasks.

**Architecture:** No new core modules. All work is in `src/providers/*` (new HistoryTreeProvider, extended PromotionTasksTreeProvider), `src/commands/*` (new compare variants + history details + task polish), and `package.json` contributes. One new schema migration adds `op_history.target_env` column so push/promote ops can record both source and target.

**Tech Stack:** Same as M3.

**Branch:** `aic-studio/m4-m6` branched from `aic-studio/m3`.

---

## File Structure

```
aic-studio/
  src/
    core/db/
      schema.ts                                  MODIFY — migration v4 (target_env column)
      opHistory.ts                               MODIFY — accept targetEnv on startOperation; expose in OpRow
      opHistory.test.ts                          MODIFY — add target_env round-trip test
    core/snapshots/
      paths.ts                                   MODIFY — add listAllSnapshotsForEnv(): returns all stamps newest-first
      paths.test.ts                              MODIFY — test for new helper
      reader.ts                                  MODIFY — add readJourneyFromSnapshot(stampDir, realm, id)
      reader.test.ts                             MODIFY — test for stamp-specific read
    providers/
      historyTree.ts                             NEW — real HistoryTreeProvider
      promotionTasksTree.ts                      MODIFY — show-archived toggle + ArchivedRoot node
    commands/
      compare.ts                                 MODIFY — add compareWithRevision + comparePickEnvs
      history.ts                                 NEW — open op details command
      promote.ts                                 MODIFY — add removeItemFromTask + deleteTask commands
    extension.ts                                 MODIFY — register HistoryTreeProvider, new commands
  package.json                                   MODIFY — add 5 new commands + menus
  tests/integration/suite/
    historyView.test.ts                          NEW — integration test
    compareExtras.test.ts                        NEW — integration test
    promotionTasksPolish.test.ts                 NEW — integration test
```

---

## Pre-Task Setup

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m4-m6 -b aic-studio/m4-m6 aic-studio/m3
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m4-m6/aic-studio
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
git -C /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m4-m6 branch --show-current   # aic-studio/m4-m6
```

All git commands run from inside `.worktrees/aic-studio-m4-m6`.

---

## Task 1: Schema migration v4 — op_history.target_env

**Files:** Modify `aic-studio/src/core/db/schema.ts`

- [ ] **Step 1: Bump SCHEMA_VERSION = 4 and append migration v4:**

```typescript
  ,{
    version: 4,
    sql: `
      ALTER TABLE op_history ADD COLUMN target_env TEXT;
    `
  }
```

After edit, MIGRATIONS has 4 entries.

- [ ] **Step 2: typecheck + connection.test (idempotent migration)** — both must pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m4-m6
git add aic-studio/src/core/db/schema.ts
git commit -m "feat(aic-studio): add op_history.target_env column (migration v4)"
```

---

## Task 2: opHistory accepts targetEnv

**Files:** Modify `aic-studio/src/core/db/opHistory.ts` and `opHistory.test.ts`

- [ ] **Step 1: Append failing test** at end of `opHistory.test.ts`:

```typescript

import { startOperation as startOp2, listOperations as listOps2 } from "./opHistory";

describe("op_history targetEnv", () => {
  it("startOperation accepts targetEnv and round-trips it", () => {
    const id = startOp2(db, { envName: "prod", opKind: "push", targetEnv: "stage" });
    const ops = listOps2(db, "prod");
    expect(ops[0].id).toBe(id);
    expect(ops[0].targetEnv).toBe("stage");
  });

  it("targetEnv is optional", () => {
    startOp2(db, { envName: "prod", opKind: "pull" });
    const ops = listOps2(db, "prod");
    expect(ops[0].targetEnv).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL** (targetEnv not in StartOpInput/OpRow)

- [ ] **Step 3: Update `opHistory.ts`:**

a) In `StartOpInput`, add `targetEnv?: string`.
b) In `OpRow`, add `targetEnv?: string`.
c) In `RawRow`, add `target_env: string | null`.
d) In `rowToOp`, add `targetEnv: r.target_env ?? undefined`.
e) Update `startOperation` INSERT to include `target_env` column + bind param:

```typescript
export function startOperation(db: Database, input: StartOpInput): number {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO op_history (env_name, op_kind, scope, status, started_at, snapshot_dir, target_env)
    VALUES (?, ?, ?, 'running', ?, ?, ?)
  `).run(
    input.envName,
    input.opKind,
    input.scope ?? null,
    now,
    input.snapshotDir ?? null,
    input.targetEnv ?? null
  );
  return Number(info.lastInsertRowid);
}
```

- [ ] **Step 4: Run → PASS** (6 total in opHistory.test.ts: 4 prior + 2 new)

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/opHistory.ts aic-studio/src/core/db/opHistory.test.ts
git commit -m "feat(aic-studio): op_history records target_env for push/promote"
```

---

## Task 3: Snapshot path + reader helpers for any-revision

**Files:** Modify `aic-studio/src/core/snapshots/paths.ts`, `paths.test.ts`, `reader.ts`, `reader.test.ts`

- [ ] **Step 1: Append failing tests** at end of `paths.test.ts`:

```typescript

import { listAllSnapshotsForEnv } from "./paths";

describe("listAllSnapshotsForEnv", () => {
  it("returns all snapshot dirs newest-first", () => {
    const root = mkdtempSync(join(tmpdir(), "snap-list-"));
    try {
      const envDir = join(root, "snapshots", "prod");
      mkdirSync(envDir, { recursive: true });
      const a = join(envDir, "2026-05-24T10-00-00Z");
      const b = join(envDir, "2026-05-24T12-00-00Z");
      const c = join(envDir, "2026-05-24T15-00-00Z");
      mkdirSync(a);
      mkdirSync(b);
      mkdirSync(c);
      const all = listAllSnapshotsForEnv(root, "prod");
      // Newest first by directory name (ISO timestamps sort lexically)
      expect(all.map((p) => p.split("/").pop())).toEqual([
        "2026-05-24T15-00-00Z",
        "2026-05-24T12-00-00Z",
        "2026-05-24T10-00-00Z"
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] when env has no snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "snap-list-empty-"));
    try {
      expect(listAllSnapshotsForEnv(root, "prod")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Append implementation** at end of `paths.ts`:

```typescript

export function listAllSnapshotsForEnv(globalStoragePath: string, envName: string): string[] {
  const dir = envSnapshotDir(globalStoragePath, envName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()
    .map((n) => join(dir, n));
}
```

- [ ] **Step 4: Run → PASS (7 paths tests)**

- [ ] **Step 5: Append failing test for reader** at end of `reader.test.ts`:

```typescript

import { readJourneyFromSnapshot } from "./reader";

describe("readJourneyFromSnapshot", () => {
  it("reads journey from a specific snapshot dir (not the latest)", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", { Login: { _id: "Login", v: 1 } });
    seed("prod", "2026-05-24T12-00-00Z", "alpha", { Login: { _id: "Login", v: 2 } });
    const olderDir = join(root, "snapshots", "prod", "2026-05-24T10-00-00Z");
    const body = readJourneyFromSnapshot(olderDir, "alpha", "Login");
    expect(body).toEqual({ _id: "Login", v: 1 });
  });

  it("returns undefined when the snapshot lacks the journey", () => {
    seed("prod", "2026-05-24T10-00-00Z", "alpha", { Login: {} });
    const dir = join(root, "snapshots", "prod", "2026-05-24T10-00-00Z");
    expect(readJourneyFromSnapshot(dir, "alpha", "Missing")).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run → FAIL**

- [ ] **Step 7: Append to `reader.ts`:**

```typescript

export function readJourneyFromSnapshot(
  snapshotDir: string,
  realm: string,
  id: string
): Record<string, unknown> | undefined {
  const file = journeyFile(snapshotDir, realm, id);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
```

- [ ] **Step 8: Run → PASS (7 reader tests)**

- [ ] **Step 9: Commit**

```bash
git add aic-studio/src/core/snapshots/paths.ts aic-studio/src/core/snapshots/paths.test.ts \
        aic-studio/src/core/snapshots/reader.ts aic-studio/src/core/snapshots/reader.test.ts
git commit -m "feat(aic-studio): snapshot helpers for revision listing + reading"
```

---

## Task 4: HistoryTreeProvider

**Files:** Create `aic-studio/src/providers/historyTree.ts`

- [ ] **Step 1: Write** (Write tool):

```typescript
// src/providers/historyTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { listOperations, type OpRow } from "../core/db/opHistory";

type Node = DayNode | OpNode;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class DayNode extends vscode.TreeItem {
  constructor(public readonly day: string, public readonly ops: OpRow[]) {
    super(day, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `day:${day}`;
    this.description = `${ops.length} op${ops.length === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon("calendar");
  }
}

export class OpNode extends vscode.TreeItem {
  constructor(public readonly op: OpRow) {
    const time = new Date(op.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    super(`${time}  ${op.opKind} ${op.envName}${op.targetEnv ? ` → ${op.targetEnv}` : ""}`, vscode.TreeItemCollapsibleState.None);
    this.id = `op:${op.id}`;
    this.description = op.status + (op.scope ? `  ${op.scope}` : "");
    const iconName = op.status === "success" ? "pass" : op.status === "failure" ? "error" : "sync~spin";
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.tooltip = new vscode.MarkdownString(
      `**${op.opKind}** ${op.scope ?? ""} \\\n` +
      `Env: \`${op.envName}\`${op.targetEnv ? ` → \`${op.targetEnv}\`` : ""} \\\n` +
      `Status: ${op.status} \\\n` +
      `Started: ${new Date(op.startedAt).toLocaleString()}${op.finishedAt ? ` \\\nFinished: ${new Date(op.finishedAt).toLocaleString()}` : ""} \\\n` +
      (op.message ? `\n\`\`\`\n${op.message}\n\`\`\`` : "")
    );
    this.command = {
      command: "aic-studio.history.openDetails",
      title: "Show operation details",
      arguments: [op.id]
    };
  }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<Node> {
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
      // Aggregate across all envs
      const envs = listEnvironments(this.db);
      const allOps: OpRow[] = [];
      for (const env of envs) {
        allOps.push(...listOperations(this.db, env.name, 200));
      }
      // Group by day
      const byDay = new Map<string, OpRow[]>();
      for (const op of allOps) {
        const key = dayKey(op.startedAt);
        const arr = byDay.get(key) ?? [];
        arr.push(op);
        byDay.set(key, arr);
      }
      return Array.from(byDay.entries())
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([day, ops]) => new DayNode(day, ops));
    }
    if (element instanceof DayNode) {
      return element.ops
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((op) => new OpNode(op));
    }
    return [];
  }
}
```

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/providers/historyTree.ts
git commit -m "feat(aic-studio): HistoryTreeProvider (replaces M1 placeholder)"
```

---

## Task 5: history details command

**Files:** Create `aic-studio/src/commands/history.ts`

- [ ] **Step 1: Write** (Write tool):

```typescript
// src/commands/history.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { listOperations } from "../core/db/opHistory";
import { log } from "../logging/output";

type Deps = { db: Database };

export function registerHistoryCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.history.openDetails", (opId: number) =>
      openDetails(deps, opId)
    )
  );
}

async function openDetails(deps: Deps, opId: number): Promise<void> {
  const envs = listEnvironments(deps.db);
  for (const env of envs) {
    const ops = listOperations(deps.db, env.name, 1000);
    const op = ops.find((o) => o.id === opId);
    if (op) {
      const text =
        `Operation #${op.id}\n` +
        `Kind:        ${op.opKind}\n` +
        `Env:         ${op.envName}${op.targetEnv ? ` → ${op.targetEnv}` : ""}\n` +
        `Scope:       ${op.scope ?? "(none)"}\n` +
        `Status:      ${op.status}\n` +
        `Started:     ${new Date(op.startedAt).toISOString()}\n` +
        `Finished:    ${op.finishedAt ? new Date(op.finishedAt).toISOString() : "—"}\n` +
        `Snapshot:    ${op.snapshotDir ?? "(none)"}\n` +
        `\nMessage:\n${op.message ?? "(none)"}\n`;
      const doc = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
  }
  log(`history.openDetails: op ${opId} not found in any env`);
  void vscode.window.showWarningMessage(`Operation #${opId} not found.`);
}
```

- [ ] **Step 2: typecheck**

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/commands/history.ts
git commit -m "feat(aic-studio): aic-studio.history.openDetails command"
```

---

## Task 6: Compare extras — compareWithRevision + comparePickEnvs

**Files:** Modify `aic-studio/src/commands/compare.ts`

- [ ] **Step 1: Read current compare.ts** — has `aic-studio.compare.withEnv`.

- [ ] **Step 2: Rewrite** to add two more commands. Write tool (overwriting):

```typescript
// src/commands/compare.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { makeAicUri } from "../providers/virtualDocs";
import type { JourneyNode } from "../providers/envTree";
import { listAllSnapshotsForEnv } from "../core/snapshots/paths";

type Deps = { db: Database; globalStoragePath: string };

export function registerCompareCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.compare.withEnv", (node?: JourneyNode) =>
      compareWithEnv(deps, node)
    ),
    vscode.commands.registerCommand("aic-studio.compare.withRevision", (node?: JourneyNode) =>
      compareWithRevision(deps, node)
    ),
    vscode.commands.registerCommand("aic-studio.compare.pickEnvs", () =>
      comparePickEnvs(deps)
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
    "vscode.diff", leftUri, rightUri,
    `${node.journeyId}: ${node.envName} ↔ ${pick.name}`
  );
}

async function compareWithRevision(deps: Deps, node?: JourneyNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage(
      "Right-click a journey in the Environments tree to compare with an older revision."
    );
    return;
  }
  const stamps = listAllSnapshotsForEnv(deps.globalStoragePath, node.envName);
  if (stamps.length < 2) {
    void vscode.window.showInformationMessage(
      `Only ${stamps.length} snapshot${stamps.length === 1 ? "" : "s"} for "${node.envName}". Pull at least twice to compare revisions.`
    );
    return;
  }
  // Skip the latest (= what aic:// already serves); offer prior snapshots.
  const prior = stamps.slice(1);
  const pick = await vscode.window.showQuickPick(
    prior.map((p) => ({
      label: p.split("/").pop()!,
      description: "older snapshot",
      stampDir: p
    })),
    { placeHolder: `Compare ${node.realm}/${node.journeyId} (latest) against which prior snapshot?` }
  );
  if (!pick) return;

  // Latest snapshot is served by the standard aic:// URI.
  const leftUri = makeAicUri(node.envName, node.realm, "journey", node.journeyId);
  // Encode the snapshot dir as a query param so the content provider can route it.
  const rightUri = vscode.Uri.from({
    scheme: "aic",
    authority: node.envName,
    path: `/${node.realm}/journey/${node.journeyId}`,
    query: `rev=${encodeURIComponent(pick.label)}`
  });
  await vscode.commands.executeCommand(
    "vscode.diff", rightUri, leftUri,
    `${node.journeyId}: ${pick.label} → latest`
  );
}

async function comparePickEnvs(deps: Deps): Promise<void> {
  const envs = listEnvironments(deps.db);
  if (envs.length < 2) {
    void vscode.window.showInformationMessage("Need at least 2 environments to compare.");
    return;
  }
  const leftPick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Left env" }
  );
  if (!leftPick) return;
  const rightPick = await vscode.window.showQuickPick(
    envs.filter((e) => e.name !== leftPick.name).map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: `Right env (vs ${leftPick.name})` }
  );
  if (!rightPick) return;
  const realm = await vscode.window.showInputBox({ prompt: "Realm", placeHolder: "alpha" });
  if (!realm) return;
  const journeyId = await vscode.window.showInputBox({ prompt: "Journey ID", placeHolder: "Login" });
  if (!journeyId) return;
  const leftUri = makeAicUri(leftPick.name, realm, "journey", journeyId);
  const rightUri = makeAicUri(rightPick.name, realm, "journey", journeyId);
  await vscode.commands.executeCommand(
    "vscode.diff", leftUri, rightUri,
    `${journeyId}: ${leftPick.name} ↔ ${rightPick.name}`
  );
}
```

- [ ] **Step 3: typecheck**

- [ ] **Step 4: Commit**

```bash
git add aic-studio/src/commands/compare.ts
git commit -m "feat(aic-studio): compare.withRevision + compare.pickEnvs commands"
```

---

## Task 7: virtualDocs provider supports ?rev= query param

**Files:** Modify `aic-studio/src/providers/virtualDocs.ts`

- [ ] **Step 1: Read** current file.

- [ ] **Step 2: Rewrite** the `AicDocumentContentProvider.provideTextDocumentContent` to honor the `?rev=` query:

```typescript
// At top of file, add an import:
import { readJourneyFromLatest, readJourneyFromSnapshot } from "../core/snapshots/reader";
import { join } from "node:path";
import { envSnapshotDir } from "../core/snapshots/paths";
```

Then replace the body of `provideTextDocumentContent`:

```typescript
  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseAicUri(uri);
    if (!parsed) return "// not an aic:// URI";
    if (parsed.resourceType !== "journey") {
      return `// resource type '${parsed.resourceType}' not supported in M2`;
    }

    // Check for ?rev=<stamp> query — read from that specific snapshot dir.
    const revMatch = uri.query.match(/(?:^|&)rev=([^&]+)/);
    if (revMatch) {
      const stamp = decodeURIComponent(revMatch[1]);
      const dir = join(envSnapshotDir(this.globalStoragePath, parsed.envName), stamp);
      const body = readJourneyFromSnapshot(dir, parsed.realm, parsed.id);
      if (!body) {
        return `// no snapshot ${stamp} for ${parsed.envName}/${parsed.realm}/${parsed.id}`;
      }
      return JSON.stringify(body, null, 2);
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
```

- [ ] **Step 3: typecheck**

- [ ] **Step 4: Commit**

```bash
git add aic-studio/src/providers/virtualDocs.ts
git commit -m "feat(aic-studio): virtualDocs honor ?rev= query for historical snapshot reads"
```

---

## Task 8: Promotion Tasks polish — archived view + item removal + task deletion

**Files:** Modify `aic-studio/src/providers/promotionTasksTree.ts`, `aic-studio/src/commands/promote.ts`, `aic-studio/src/core/db/promotionTasks.ts` + tests

- [ ] **Step 1: Append failing tests** in `promotionTasks.test.ts`:

```typescript

import { deletePromotionTask, listArchivedTasks } from "./promotionTasks";

describe("promotion_tasks deletion + archived listing", () => {
  it("deletePromotionTask removes task + cascades item rows", () => {
    const id = createPromotionTask(db, { name: "t", sourceEnv: "prod" });
    addItemToTask(db, id, { realm: "alpha", resourceType: "journey", resourceId: "Login" });
    deletePromotionTask(db, id);
    expect(getTask(db, id)).toBeUndefined();
    expect(listItemsInTask(db, id)).toHaveLength(0);
  });

  it("listArchivedTasks returns only 'archived' tasks", () => {
    const a = createPromotionTask(db, { name: "active", sourceEnv: "prod" });
    const b = createPromotionTask(db, { name: "archived", sourceEnv: "prod" });
    setTaskStatus(db, b, "archived");
    expect(listArchivedTasks(db).map((t) => t.id)).toEqual([b]);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Append to `promotionTasks.ts`:**

```typescript

export function deletePromotionTask(db: Database, id: number): void {
  // ON DELETE CASCADE handles items
  db.prepare("DELETE FROM promotion_tasks WHERE id = ?").run(id);
}

export function listArchivedTasks(db: Database): PromotionTaskRow[] {
  const rows = db.prepare(`
    SELECT * FROM promotion_tasks WHERE status = 'archived' ORDER BY updated_at DESC
  `).all() as RawTaskRow[];
  return rows.map(rowToTask);
}
```

- [ ] **Step 4: Run → PASS (7 tests in promotionTasks.test.ts)**

- [ ] **Step 5: Extend `promotionTasksTree.ts`** to support archived-view toggle. Use Write tool (overwriting):

```typescript
// src/providers/promotionTasksTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  listActiveTasks,
  listArchivedTasks,
  listItemsInTask,
  type PromotionTaskRow,
  type TaskItem
} from "../core/db/promotionTasks";

type Node = ArchivedRootNode | TaskNode | ItemNode;

export class ArchivedRootNode extends vscode.TreeItem {
  constructor(count: number) {
    super(`Archived (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "archived-root";
    this.contextValue = "aic-studio.archivedRoot";
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

export class TaskNode extends vscode.TreeItem {
  constructor(public readonly task: PromotionTaskRow) {
    super(task.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `promotion-task:${task.id}`;
    this.contextValue = task.status === "archived" ? "aic-studio.archivedTask" : "aic-studio.promotionTask";
    this.description = `from ${task.sourceEnv}`;
    this.iconPath = new vscode.ThemeIcon(task.status === "archived" ? "archive" : "rocket");
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
      const active = listActiveTasks(this.db);
      const archivedCount = listArchivedTasks(this.db).length;
      const nodes: Node[] = active.map((t) => new TaskNode(t));
      if (archivedCount > 0) nodes.push(new ArchivedRootNode(archivedCount));
      return nodes;
    }
    if (element instanceof ArchivedRootNode) {
      return listArchivedTasks(this.db).map((t) => new TaskNode(t));
    }
    if (element instanceof TaskNode) {
      return listItemsInTask(this.db, element.task.id).map((i) => new ItemNode(element.task.id, i));
    }
    return [];
  }
}
```

- [ ] **Step 6: Append two more commands to `promote.ts`** (Edit tool). After the existing `archiveTaskCommand` function and BEFORE the closing of the file, add:

```typescript

async function removeItemCommand(deps: Deps, node?: { taskId: number; item: TaskItem }): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage("Right-click an item inside a promotion task to remove it.");
    return;
  }
  const { removeItemFromTask } = await import("../core/db/promotionTasks");
  removeItemFromTask(deps.db, node.taskId, node.item);
  deps.onChange();
}

async function deleteTaskCommand(deps: Deps, node?: TaskNode): Promise<void> {
  const { deletePromotionTask } = await import("../core/db/promotionTasks");
  let taskId: number;
  let taskName: string;
  if (node) {
    taskId = node.task.id;
    taskName = node.task.name;
  } else {
    void vscode.window.showInformationMessage("Right-click a promotion task to delete it.");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete promotion task "${taskName}" permanently? Item entries are also deleted.`,
    { modal: true },
    "Delete"
  );
  if (confirm !== "Delete") return;
  deletePromotionTask(deps.db, taskId);
  deps.onChange();
}
```

Also register them in `registerPromoteCommands`:

```typescript
    vscode.commands.registerCommand("aic-studio.promote.removeItem", (node?: { taskId: number; item: TaskItem }) =>
      removeItemCommand(deps, node)
    ),
    vscode.commands.registerCommand("aic-studio.promote.deleteTask", (node?: TaskNode) =>
      deleteTaskCommand(deps, node)
    )
```

(Add these inside the existing `ctx.subscriptions.push(...)` call.)

- [ ] **Step 7: typecheck**

- [ ] **Step 8: Commit**

```bash
git add aic-studio/src/core/db/promotionTasks.ts aic-studio/src/core/db/promotionTasks.test.ts \
        aic-studio/src/providers/promotionTasksTree.ts \
        aic-studio/src/commands/promote.ts
git commit -m "feat(aic-studio): promotion tasks — archived view, item removal, task deletion"
```

---

## Task 9: package.json contributes (5 new commands + menus)

**Files:** Modify `aic-studio/package.json`

- [ ] **Step 1: Add commands** at end of `commands` array:

```json
      ,
      { "command": "aic-studio.compare.withRevision", "title": "AIC Studio: Compare with revision…", "category": "AIC Studio" },
      { "command": "aic-studio.compare.pickEnvs", "title": "AIC Studio: Compare envs (pick two)…", "category": "AIC Studio" },
      { "command": "aic-studio.history.openDetails", "title": "AIC Studio: Show operation details", "category": "AIC Studio" },
      { "command": "aic-studio.promote.removeItem", "title": "AIC Studio: Remove item from promotion task", "category": "AIC Studio" },
      { "command": "aic-studio.promote.deleteTask", "title": "AIC Studio: Delete promotion task…", "category": "AIC Studio" }
```

- [ ] **Step 2: Extend `view/item/context` menu** — add these entries inside the existing `view/item/context` array:

```json
        ,
        { "command": "aic-studio.compare.withRevision", "when": "viewItem == aic-studio.journey", "group": "1_compare" },
        { "command": "aic-studio.promote.removeItem", "when": "viewItem == aic-studio.promotionTaskItem", "group": "inline" },
        { "command": "aic-studio.promote.deleteTask", "when": "viewItem == aic-studio.promotionTask || viewItem == aic-studio.archivedTask", "group": "3_delete" }
```

- [ ] **Step 3: Validate JSON.** Run `node -e "JSON.parse(require('fs').readFileSync('aic-studio/package.json'))" && echo OK`.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/package.json
git commit -m "feat(aic-studio): contribute compare/history/promote-polish commands + menus"
```

---

## Task 10: Wire HistoryTreeProvider + new command groups into extension.ts

**Files:** Modify `aic-studio/src/extension.ts`

- [ ] **Step 1: Read** the file.

- [ ] **Step 2: Update imports** — replace the import line that pulls placeholder `historyTree` from `./providers/placeholderTrees` (still alongside monitorsTree, logsTree), to drop historyTree:

```typescript
import {
  monitorsTree,
  logsTree
} from "./providers/placeholderTrees";
import { HistoryTreeProvider } from "./providers/historyTree";
import { registerHistoryCommands } from "./commands/history";
```

- [ ] **Step 3: Instantiate the new tree** — after `const promotionTasksTreeProvider = new PromotionTasksTreeProvider(db);`, add:

```typescript
    const historyTreeProvider = new HistoryTreeProvider(db);
```

- [ ] **Step 4: Use it in registerTreeDataProvider** — replace the line `vscode.window.registerTreeDataProvider("aic-studio.history", historyTree),` with `vscode.window.registerTreeDataProvider("aic-studio.history", historyTreeProvider),`.

- [ ] **Step 5: Update registerCompareCommands call** — its `Deps` now requires `globalStoragePath`. Find the line:

```typescript
    registerCompareCommands(ctx, { db });
```

Replace with:

```typescript
    registerCompareCommands(ctx, { db, globalStoragePath: ctx.globalStorageUri.fsPath });
```

- [ ] **Step 6: Register history commands** — after `registerCompareCommands(...)`, add:

```typescript
    registerHistoryCommands(ctx, { db });
```

- [ ] **Step 7: Extend onChange callbacks** so the push/promote/env onChange callbacks also refresh `historyTreeProvider`. Add `historyTreeProvider.refresh();` to all 4 existing onChange callbacks (env, sync, push, promote).

- [ ] **Step 8: Build**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m4-m6/aic-studio && npm run build
```

- [ ] **Step 9: Commit**

```bash
git add aic-studio/src/extension.ts
git commit -m "feat(aic-studio): wire HistoryTreeProvider + new compare/history commands"
```

---

## Task 11: Integration tests

**Files:**
- Create: `aic-studio/tests/integration/suite/historyView.test.ts`
- Create: `aic-studio/tests/integration/suite/compareExtras.test.ts`
- Create: `aic-studio/tests/integration/suite/promotionTasksPolish.test.ts`
- Modify: `aic-studio/esbuild.config.mjs` (add 3 entry points)

- [ ] **Step 1: Write three tests:**

```typescript
// tests/integration/suite/historyView.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("History view + details command", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("history.openDetails is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.history.openDetails"));
  });

  test("history.openDetails with missing id surfaces warning without throwing", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.history.openDetails", 999999))
    );
  });
});
```

```typescript
// tests/integration/suite/compareExtras.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Compare extras", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("compare.withRevision is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.compare.withRevision"));
  });

  test("compare.pickEnvs is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.compare.pickEnvs"));
  });

  test("compare.withRevision without node argument does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.compare.withRevision"))
    );
  });
});
```

```typescript
// tests/integration/suite/promotionTasksPolish.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Promotion tasks polish", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("promote.removeItem is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.removeItem"));
  });

  test("promote.deleteTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.deleteTask"));
  });
});
```

- [ ] **Step 2: Add all 3 to esbuild entryPoints**

- [ ] **Step 3: Run integration tests**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m4-m6/aic-studio && npm run test:integration
```

Expected: 19 prior + 7 new = 26 tests pass.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/tests/integration/suite/historyView.test.ts \
        aic-studio/tests/integration/suite/compareExtras.test.ts \
        aic-studio/tests/integration/suite/promotionTasksPolish.test.ts \
        aic-studio/esbuild.config.mjs
git commit -m "test(aic-studio): integration tests for M4-M6 commands"
```

---

## Task 12: CHANGELOG + acceptance gate

**Files:** Modify `aic-studio/CHANGELOG.md` then verify

- [ ] **Step 1: Add CHANGELOG entry** above M3 section:

```markdown
### Added (M4-M6 — UI completions: compare extras, history, promotion tasks polish)

- `aic-studio.compare.withRevision` — compare a journey against an older snapshot of the same env
- `aic-studio.compare.pickEnvs` — palette command to compare any two envs / journey
- HistoryTreeProvider populates the History sidebar (replaces M1 placeholder); grouped by day
- `aic-studio.history.openDetails` opens a read-only document with full op metadata
- Promotion Tasks tree adds an "Archived" expandable root
- `aic-studio.promote.removeItem` and `aic-studio.promote.deleteTask` commands
- `op_history` records `target_env` for push/promote (schema migration v4)
- Snapshot helpers: `listAllSnapshotsForEnv`, `readJourneyFromSnapshot`
- 7 new integration tests (26 total); ~5 new unit tests (~75 total)

```

- [ ] **Step 2: Commit**

```bash
git add aic-studio/CHANGELOG.md
git commit -m "docs(aic-studio): CHANGELOG for M4-M6"
```

- [ ] **Step 3: Run acceptance gate**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m4-m6/aic-studio
rm -rf node_modules out coverage && npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
npm run typecheck && npm run lint
npm rebuild better-sqlite3 && npm test -- --run
npm run build
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
npm run test:integration
npm rebuild better-sqlite3 && npm test -- --run --coverage
```

Expected: typecheck/lint clean; ~75 unit pass; 26 integration pass; core coverage ≥85/85/85/75. NO COMMIT.

---

## Self-Review

**Spec coverage:**
- §2 UI mapping: Compare with revision (Task 6, 7), Compare pick envs palette (Task 6), History as TreeView (Task 4, 5), Promotion Tasks polish (Task 8). ✓
- §3 data: op_history extended w/ target_env (Tasks 1, 2). ✓
- §4 command surface: 5 new commands match the naming convention. ✓
- §6 testing: TDD for all core changes + integration smoke for commands. ✓

**Placeholder scan:** None.

**Type consistency:** `Deps` for compare now includes `globalStoragePath` (Tasks 6 + extension.ts wiring in Task 10). HistoryTreeProvider methods consistent with PromotionTasksTreeProvider pattern. `OpRow.targetEnv` added in Task 2, used in OpNode tooltip (Task 4) and history details (Task 5).

Plan ready.
