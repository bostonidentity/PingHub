// src/commands/logs.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments, getEnvironmentByName } from "../core/db/environments";
import { getSavedQuery, deleteSavedQuery } from "../core/db/savedLogQueries";
import type { SecretStore } from "../core/env/secrets";
import { log } from "../logging/output";
import type { SavedQueryNode } from "../providers/logsTree";

export interface LogsCommandDeps {
  db: Database;
  secrets: SecretStore;
  onChange: () => void;
  openQueryEditor: (envName: string, savedQueryId?: number) => void;
}

export function registerLogsCommands(ctx: vscode.ExtensionContext, deps: LogsCommandDeps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.logs.openQueryEditor", (envOrNode?: { env?: { name: string } } | string) =>
      openQueryEditorCmd(deps, envOrNode)
    ),
    vscode.commands.registerCommand("aic-studio.logs.runSavedQuery", (idOrNode?: number | SavedQueryNode) =>
      runSavedQueryCmd(deps, idOrNode)
    ),
    vscode.commands.registerCommand("aic-studio.logs.deleteSavedQuery", (node?: SavedQueryNode) =>
      deleteSavedQueryCmd(deps, node)
    )
  );
}

async function openQueryEditorCmd(deps: LogsCommandDeps, envOrNode?: { env?: { name: string } } | string): Promise<void> {
  let envName: string | undefined;
  if (typeof envOrNode === "string") {
    envName = envOrNode;
  } else if (envOrNode && typeof envOrNode === "object" && "env" in envOrNode && envOrNode.env) {
    envName = envOrNode.env.name;
  } else {
    const envs = listEnvironments(deps.db);
    if (envs.length === 0) {
      void vscode.window.showInformationMessage("No environments configured.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
      { placeHolder: "Query logs from which env?" }
    );
    if (!pick) return;
    envName = pick.name;
  }
  if (!envName) return;
  const env = getEnvironmentByName(deps.db, envName);
  if (!env) {
    void vscode.window.showErrorMessage(`Unknown environment: ${envName}`);
    return;
  }
  const apiKey = await deps.secrets.get(envName, "log-api-key");
  const apiSecret = await deps.secrets.get(envName, "log-api-secret");
  if (!apiKey || !apiSecret) {
    const set = await vscode.window.showWarningMessage(
      `Log API credentials not configured for "${envName}". Set them now?`,
      "Set credentials"
    );
    if (set !== "Set credentials") return;
    const key = await vscode.window.showInputBox({ prompt: `Log API key for ${envName}`, password: true });
    if (!key) return;
    const secret = await vscode.window.showInputBox({ prompt: `Log API secret for ${envName}`, password: true });
    if (!secret) return;
    await deps.secrets.set(envName, "log-api-key", key);
    await deps.secrets.set(envName, "log-api-secret", secret);
    log(`logs: stored API credentials for ${envName}`);
  }
  deps.openQueryEditor(envName);
}

async function runSavedQueryCmd(deps: LogsCommandDeps, idOrNode?: number | SavedQueryNode): Promise<void> {
  let id: number | undefined;
  if (typeof idOrNode === "number") {
    id = idOrNode;
  } else if (idOrNode && "query" in idOrNode) {
    id = idOrNode.query.id;
  } else {
    void vscode.window.showInformationMessage("Click a saved query in the Logs view to run it.");
    return;
  }
  const q = getSavedQuery(deps.db, id);
  if (!q) {
    void vscode.window.showErrorMessage(`Saved query #${id} not found.`);
    return;
  }
  deps.openQueryEditor(q.envName, id);
}

async function deleteSavedQueryCmd(deps: LogsCommandDeps, node?: SavedQueryNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage("Right-click a saved query to delete it.");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete saved log query "${node.query.name}"?`,
    { modal: true },
    "Delete"
  );
  if (confirm !== "Delete") return;
  deleteSavedQuery(deps.db, node.query.id);
  log(`logs: deleted saved query #${node.query.id}`);
  deps.onChange();
}
