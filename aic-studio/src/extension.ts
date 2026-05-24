// src/extension.ts
import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./core/db/connection";
import { makeStorage } from "./core/env/secrets";
import { EnvironmentsTreeProvider } from "./providers/envTree";
import {
  monitorsTree,
  logsTree
} from "./providers/placeholderTrees";
import { HistoryTreeProvider } from "./providers/historyTree";
import { registerHistoryCommands } from "./commands/history";
import { PromotionTasksTreeProvider } from "./providers/promotionTasksTree";
import { registerPushCommands } from "./commands/push";
import { registerPromoteCommands } from "./commands/promote";
import { ActiveEnvStatusBar } from "./status/activeEnvStatusBar";
import { registerEnvCommands } from "./commands/env";
import { initLogger, log, logError } from "./logging/output";
import { AicDocumentContentProvider, AIC_SCHEME } from "./providers/virtualDocs";
import { EnvSourceControlRegistry } from "./providers/sourceControl";
import { registerSyncCommands } from "./commands/sync";
import { registerCompareCommands } from "./commands/compare";
import { PullProgressStatusBar } from "./status/pullProgress";
import { FederationEditorHost } from "./webviews/host/federationHost";
import { registerFederationCommands } from "./commands/federation";

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
    const promotionTasksTreeProvider = new PromotionTasksTreeProvider(db);
    const historyTreeProvider = new HistoryTreeProvider(db);
    const statusBar = new ActiveEnvStatusBar(ctx, db);

    ctx.subscriptions.push(
      vscode.window.registerTreeDataProvider("aic-studio.environments", envTree),
      vscode.window.registerTreeDataProvider("aic-studio.promotionTasks", promotionTasksTreeProvider),
      vscode.window.registerTreeDataProvider("aic-studio.history", historyTreeProvider),
      vscode.window.registerTreeDataProvider("aic-studio.monitors", monitorsTree),
      vscode.window.registerTreeDataProvider("aic-studio.logs", logsTree)
    );

    const pullStatus = new PullProgressStatusBar(ctx);
    const scmRegistry = new EnvSourceControlRegistry(ctx, db, ctx.globalStorageUri.fsPath);
    scmRegistry.syncFromDb();

    const contentProvider = new AicDocumentContentProvider(ctx.globalStorageUri.fsPath);
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(AIC_SCHEME, contentProvider)
    );

    registerEnvCommands(ctx, {
      db,
      secrets,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        scmRegistry.syncFromDb();
        promotionTasksTreeProvider.refresh();
        historyTreeProvider.refresh();
      }
    });

    registerSyncCommands(ctx, {
      db,
      secrets,
      globalStoragePath: ctx.globalStorageUri.fsPath,
      pullStatus,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        scmRegistry.syncFromDb();
        promotionTasksTreeProvider.refresh();
        historyTreeProvider.refresh();
      }
    });

    registerCompareCommands(ctx, { db, globalStoragePath: ctx.globalStorageUri.fsPath });

    registerHistoryCommands(ctx, { db });

    registerPushCommands(ctx, {
      db,
      secrets,
      globalStoragePath: ctx.globalStorageUri.fsPath,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        scmRegistry.refreshChanges();
        historyTreeProvider.refresh();
      }
    });

    registerPromoteCommands(ctx, {
      db,
      secrets,
      globalStoragePath: ctx.globalStorageUri.fsPath,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        promotionTasksTreeProvider.refresh();
        historyTreeProvider.refresh();
      }
    });

    const federationHost = new FederationEditorHost({
      ctx,
      db,
      secrets,
      globalStoragePath: ctx.globalStorageUri.fsPath,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        historyTreeProvider.refresh();
      }
    });

    registerFederationCommands(ctx, federationHost);

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
