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
