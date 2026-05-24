// src/status/activeEnvStatusBar.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { getActiveEnvironment, getEnvironmentByName } from "../core/db/environments";

const COMMAND_SET_ACTIVE = "aic-studio.env.setActive";

export class ActiveEnvStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(ctx: vscode.ExtensionContext, private readonly db: Database) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = COMMAND_SET_ACTIVE;
    ctx.subscriptions.push(this.item);
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const name = getActiveEnvironment(this.db);
    if (!name) {
      this.item.text = "$(globe) AIC: (no env)";
      this.item.tooltip = "Click to set the active AIC environment";
      return;
    }
    const env = getEnvironmentByName(this.db, name);
    this.item.text = `$(globe) ${env?.label ?? name}`;
    this.item.tooltip = `Active AIC environment: ${name}\nClick to switch`;
  }
}
