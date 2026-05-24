// src/providers/envTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments, getActiveEnvironment } from "../core/db/environments";
import type { Environment } from "../core/env/types";

export class EnvNode extends vscode.TreeItem {
  constructor(public readonly env: Environment, isActive: boolean) {
    super(env.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `env:${env.name}`;
    this.contextValue = "aic-studio.env";
    this.description = env.name + (isActive ? "  ●" : "");
    this.iconPath = new vscode.ThemeIcon("globe");
    this.tooltip = new vscode.MarkdownString(
      `**${env.label}** \\\n` +
      `\`${env.name}\` \\\n` +
      `${env.tenantUrl} \\\n` +
      `User: ${env.username}`
    );
  }
}

export class EnvironmentsTreeProvider implements vscode.TreeDataProvider<EnvNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<EnvNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly db: Database) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: EnvNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: EnvNode): EnvNode[] {
    if (element) {
      // Children of an env (Configs, Health, etc.) come in M2.
      return [];
    }
    const active = getActiveEnvironment(this.db);
    return listEnvironments(this.db).map((env) => new EnvNode(env, env.name === active));
  }
}
