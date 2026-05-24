// src/providers/monitorsTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import type { Environment } from "../core/env/types";
import { latestCheck, listActiveAlerts, type MonitorCheckRow, type AlertRow } from "../core/db/monitorChecks";

type Node = EnvHealthNode | CheckTypeNode | AlertNode;

const CHECK_TYPES = ["tls", "ping", "rcs"] as const;

function iconFor(status: string | undefined): vscode.ThemeIcon {
  if (status === "ok") return new vscode.ThemeIcon("pass");
  if (status === "warning") return new vscode.ThemeIcon("warning");
  if (status === "error") return new vscode.ThemeIcon("error");
  return new vscode.ThemeIcon("question");
}

export class EnvHealthNode extends vscode.TreeItem {
  constructor(public readonly env: Environment, alertCount: number) {
    super(env.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `monitor-env:${env.name}`;
    this.contextValue = "aic-studio.monitorEnv";
    this.description = alertCount > 0 ? `${alertCount} alert${alertCount === 1 ? "" : "s"}` : "";
    this.iconPath = new vscode.ThemeIcon(alertCount > 0 ? "warning" : "pulse");
  }
}

export class CheckTypeNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly checkType: string, latest: MonitorCheckRow | undefined) {
    const status = latest?.status ?? "unknown";
    super(`${checkType}: ${status}`, vscode.TreeItemCollapsibleState.None);
    this.id = `monitor-check:${envName}:${checkType}`;
    this.contextValue = "aic-studio.monitorCheck";
    this.description = latest?.detail ?? (latest?.daysRemaining !== undefined ? `${latest.daysRemaining}d` : "no data");
    this.iconPath = iconFor(latest?.status);
    if (latest) {
      this.tooltip = new vscode.MarkdownString(
        `**${checkType}** for \`${envName}\` \\\n` +
        `Status: ${latest.status} \\\n` +
        `${latest.detail ? `Detail: ${latest.detail} \\\n` : ""}` +
        `Checked: ${new Date(latest.checkedAt).toLocaleString()}`
      );
    }
  }
}

export class AlertNode extends vscode.TreeItem {
  constructor(public readonly alert: AlertRow) {
    super(alert.message, vscode.TreeItemCollapsibleState.None);
    this.id = `monitor-alert:${alert.id}`;
    this.contextValue = "aic-studio.monitorAlert";
    this.description = `${alert.severity} · ${alert.checkType}`;
    this.iconPath = iconFor(alert.severity === "error" ? "error" : "warning");
  }
}

export class MonitorsTreeProvider implements vscode.TreeDataProvider<Node> {
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
      return listEnvironments(this.db).map(
        (env) => new EnvHealthNode(env, listActiveAlerts(this.db, env.name).length)
      );
    }
    if (element instanceof EnvHealthNode) {
      const nodes: Node[] = CHECK_TYPES.map(
        (type) => new CheckTypeNode(element.env.name, type, latestCheck(this.db, element.env.name, type))
      );
      const alerts = listActiveAlerts(this.db, element.env.name);
      for (const a of alerts) nodes.push(new AlertNode(a));
      return nodes;
    }
    return [];
  }
}
