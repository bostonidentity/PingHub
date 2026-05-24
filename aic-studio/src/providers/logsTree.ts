// src/providers/logsTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import type { Environment } from "../core/env/types";
import { listSavedQueries, type SavedLogQueryRow } from "../core/db/savedLogQueries";

type Node = LogsEnvNode | SavedQueryNode | EmptyNode;

export class LogsEnvNode extends vscode.TreeItem {
  constructor(public readonly env: Environment, queryCount: number) {
    super(env.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `logs-env:${env.name}`;
    this.contextValue = "aic-studio.logsEnv";
    this.description = `${queryCount} saved`;
    this.iconPath = new vscode.ThemeIcon("globe");
  }
}

export class SavedQueryNode extends vscode.TreeItem {
  constructor(public readonly query: SavedLogQueryRow) {
    super(query.name, vscode.TreeItemCollapsibleState.None);
    this.id = `saved-query:${query.id}`;
    this.contextValue = "aic-studio.savedLogQuery";
    this.description = query.source + (query.filterExpr ? `  ·  filtered` : "");
    this.iconPath = new vscode.ThemeIcon("filter");
    this.tooltip = new vscode.MarkdownString(
      `**${query.name}** \\\n` +
      `Source: \`${query.source}\` \\\n` +
      `${query.filterExpr ? `Filter: \`${query.filterExpr}\` \\\n` : ""}` +
      `${query.lastRunAt ? `Last run: ${new Date(query.lastRunAt).toLocaleString()}` : "Never run"}`
    );
    this.command = {
      command: "aic-studio.logs.runSavedQuery",
      title: "Run saved log query",
      arguments: [query.id]
    };
  }
}

export class EmptyNode extends vscode.TreeItem {
  constructor() {
    super("No saved queries. Right-click env → 'Open log query editor…'", vscode.TreeItemCollapsibleState.None);
    this.id = "logs-empty";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export class LogsTreeProvider implements vscode.TreeDataProvider<Node> {
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
        (env) => new LogsEnvNode(env, listSavedQueries(this.db, env.name).length)
      );
    }
    if (element instanceof LogsEnvNode) {
      const queries = listSavedQueries(this.db, element.env.name);
      if (queries.length === 0) return [new EmptyNode()];
      return queries.map((q) => new SavedQueryNode(q));
    }
    return [];
  }
}
