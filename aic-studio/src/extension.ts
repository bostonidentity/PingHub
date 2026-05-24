// src/extension.ts
import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./core/db/connection";
import { makeStorage } from "./core/env/secrets";
import { EnvironmentsTreeProvider } from "./providers/envTree";
import {
  promotionTasksTree,
  historyTree,
  monitorsTree,
  logsTree
} from "./providers/placeholderTrees";
import { ActiveEnvStatusBar } from "./status/activeEnvStatusBar";
import { registerEnvCommands } from "./commands/env";
import { initLogger, log, logError } from "./logging/output";

export function activate(ctx: vscode.ExtensionContext): void {
  initLogger(ctx);
  log("AIC Studio activating…");

  try {
    mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
    const db = openDatabase(join(ctx.globalStorageUri.fsPath, "pinghub.db"));
    ctx.subscriptions.push({ dispose: () => db.close() });

    const secrets = makeStorage({
      get: (k) => Promise.resolve(ctx.secrets.get(k)),
      store: (k, v) => Promise.resolve(ctx.secrets.store(k, v)),
      delete: (k) => Promise.resolve(ctx.secrets.delete(k))
    });

    const envTree = new EnvironmentsTreeProvider(db, ctx.globalStorageUri.fsPath);
    const statusBar = new ActiveEnvStatusBar(ctx, db);

    ctx.subscriptions.push(
      vscode.window.registerTreeDataProvider("aic-studio.environments", envTree),
      vscode.window.registerTreeDataProvider("aic-studio.promotionTasks", promotionTasksTree),
      vscode.window.registerTreeDataProvider("aic-studio.history", historyTree),
      vscode.window.registerTreeDataProvider("aic-studio.monitors", monitorsTree),
      vscode.window.registerTreeDataProvider("aic-studio.logs", logsTree)
    );

    registerEnvCommands(ctx, {
      db,
      secrets,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
      }
    });

    log("AIC Studio activated");
  } catch (err) {
    logError("activation failed", err);
    void vscode.window.showErrorMessage(
      `AIC Studio failed to activate: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function deactivate(): void {
  // Subscriptions handle teardown via ctx.subscriptions
}
