// src/status/monitorAlertStatusBar.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { listActiveAlerts } from "../core/db/monitorChecks";

export class MonitorAlertStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(ctx: vscode.ExtensionContext, private readonly db: Database) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.item.command = "workbench.view.extension.aic-studio";
    ctx.subscriptions.push(this.item);
  }

  refresh(): void {
    const envs = listEnvironments(this.db);
    let total = 0;
    for (const env of envs) {
      total += listActiveAlerts(this.db, env.name).length;
    }
    if (total === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(warning) ${total} alert${total === 1 ? "" : "s"}`;
    this.item.tooltip = `${total} active monitor alert${total === 1 ? "" : "s"}. Click to open the AIC Studio sidebar.`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.show();
  }
}
