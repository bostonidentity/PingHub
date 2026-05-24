// src/extension.ts
import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./core/db/connection";
import { listEnvironments } from "./core/db/environments";
import { makeStorage } from "./core/env/secrets";
import { EnvironmentsTreeProvider } from "./providers/envTree";
// (placeholderTrees no longer needed — all placeholders replaced)
import { LogsTreeProvider } from "./providers/logsTree";
import { LogsQueryHost } from "./webviews/host/logsQueryHost";
import { registerLogsCommands } from "./commands/logs";
import { MonitorsTreeProvider } from "./providers/monitorsTree";
import { MonitorScheduler } from "./core/monitors/scheduler";
import { MonitorAlertStatusBar } from "./status/monitorAlertStatusBar";
import { MonitorDashboardHost } from "./webviews/host/monitorDashboardHost";
import { registerMonitorCommands, checkOneEnv } from "./commands/monitor";
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
import { AnalyzeHost } from "./webviews/host/analyzeHost";
import { registerAnalyzeCommands } from "./commands/analyze";
import { DashboardHost } from "./webviews/host/dashboardHost";
import { registerDashboardCommands } from "./commands/dashboard";
import { registerSearchCommands } from "./commands/search";

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
    const monitorsTreeProvider = new MonitorsTreeProvider(db);
    const monitorAlertStatusBar = new MonitorAlertStatusBar(ctx, db);
    const monitorDashboardHost = new MonitorDashboardHost({ ctx, db });
    const logsTreeProvider = new LogsTreeProvider(db);
    const logsQueryHost = new LogsQueryHost({
      ctx,
      db,
      secrets,
      onChange: () => {
        logsTreeProvider.refresh();
      }
    });
    const statusBar = new ActiveEnvStatusBar(ctx, db);

    ctx.subscriptions.push(
      vscode.window.registerTreeDataProvider("aic-studio.environments", envTree),
      vscode.window.registerTreeDataProvider("aic-studio.promotionTasks", promotionTasksTreeProvider),
      vscode.window.registerTreeDataProvider("aic-studio.history", historyTreeProvider),
      vscode.window.registerTreeDataProvider("aic-studio.monitors", monitorsTreeProvider),
      vscode.window.registerTreeDataProvider("aic-studio.logs", logsTreeProvider)
    );

    const pullStatus = new PullProgressStatusBar(ctx);
    const scmRegistry = new EnvSourceControlRegistry(ctx, db, ctx.globalStorageUri.fsPath);
    scmRegistry.syncFromDb();

    const contentProvider = new AicDocumentContentProvider(ctx.globalStorageUri.fsPath);
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(AIC_SCHEME, contentProvider)
    );

    const dashboardHost = new DashboardHost({
      ctx,
      db,
      globalStoragePath: ctx.globalStorageUri.fsPath
    });
    registerDashboardCommands(ctx, dashboardHost);

    registerSearchCommands(ctx, {
      db,
      globalStoragePath: ctx.globalStorageUri.fsPath
    });

    registerEnvCommands(ctx, {
      db,
      secrets,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
        scmRegistry.syncFromDb();
        promotionTasksTreeProvider.refresh();
        historyTreeProvider.refresh();
        monitorsTreeProvider.refresh();
        monitorAlertStatusBar.refresh();
        logsTreeProvider.refresh();
        dashboardHost.refresh();
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
        monitorsTreeProvider.refresh();
        monitorAlertStatusBar.refresh();
        logsTreeProvider.refresh();
        dashboardHost.refresh();
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
        monitorsTreeProvider.refresh();
        monitorAlertStatusBar.refresh();
        dashboardHost.refresh();
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
        monitorsTreeProvider.refresh();
        monitorAlertStatusBar.refresh();
        dashboardHost.refresh();
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

    registerMonitorCommands(ctx, {
      db,
      secrets,
      onChange: () => {
        monitorsTreeProvider.refresh();
        monitorAlertStatusBar.refresh();
        monitorDashboardHost.refresh();
        dashboardHost.refresh();
      },
      openDashboard: () => monitorDashboardHost.open()
    });

    registerLogsCommands(ctx, {
      db,
      secrets,
      onChange: () => {
        logsTreeProvider.refresh();
      },
      openQueryEditor: (envName: string, savedQueryId?: number) => logsQueryHost.open(envName, savedQueryId)
    });

    const analyzeHost = new AnalyzeHost({ ctx, globalStoragePath: ctx.globalStorageUri.fsPath });
    registerAnalyzeCommands(ctx, analyzeHost);

    // Read poll interval from config (default 15 minutes)
    const pollMinutes = vscode.workspace.getConfiguration("aic-studio").get<number>("monitor.pollIntervalMinutes") ?? 15;
    const monitorScheduler = new MonitorScheduler({
      intervalMs: pollMinutes * 60_000,
      runOnce: async () => {
        for (const env of listEnvironments(db)) {
          await checkOneEnv({ db, secrets, onChange: () => {}, openDashboard: () => {} }, env.name);
        }
        monitorsTreeProvider.refresh();
        monitorAlertStatusBar.refresh();
        monitorDashboardHost.refresh();
      }
    });
    monitorScheduler.start();
    ctx.subscriptions.push({ dispose: () => monitorScheduler.stop() });
    monitorAlertStatusBar.refresh();

    const autoOpen = vscode.workspace.getConfiguration("aic-studio").get<boolean>("autoOpenDashboard");
    if (autoOpen !== false) {
      // Default true unless user explicitly disabled
      void vscode.commands.executeCommand("aic-studio.view.openDashboard");
    }

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
