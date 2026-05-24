// src/providers/envTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments, getActiveEnvironment } from "../core/db/environments";
import type { Environment } from "../core/env/types";
import { listRealmsInLatest, listJourneysInLatest } from "../core/snapshots/reader";
import { makeAicUri } from "./virtualDocs";

type TreeNode = EnvNode | RealmNode | CategoryNode | JourneyNode;

export class EnvNode extends vscode.TreeItem {
  constructor(public readonly env: Environment, isActive: boolean) {
    super(env.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `env:${env.name}`;
    this.contextValue = "aic-studio.env";
    this.description = env.name + (isActive ? "  ●" : "");
    this.iconPath = new vscode.ThemeIcon("globe");
    this.tooltip = new vscode.MarkdownString(
      `**${env.label}** \\\n\`${env.name}\` \\\n${env.tenantUrl} \\\nUser: ${env.username}`
    );
  }
}

export class RealmNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string) {
    super(realm, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `realm:${envName}:${realm}`;
    this.contextValue = "aic-studio.realm";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class CategoryNode extends vscode.TreeItem {
  constructor(
    public readonly envName: string,
    public readonly realm: string,
    public readonly category: "journeys",
    count: number
  ) {
    super(`Journeys (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `cat:${envName}:${realm}:${category}`;
    this.contextValue = "aic-studio.category";
    this.iconPath = new vscode.ThemeIcon("symbol-event");
  }
}

export class JourneyNode extends vscode.TreeItem {
  constructor(
    public readonly envName: string,
    public readonly realm: string,
    public readonly journeyId: string
  ) {
    super(journeyId, vscode.TreeItemCollapsibleState.None);
    this.id = `journey:${envName}:${realm}:${journeyId}`;
    this.contextValue = "aic-studio.journey";
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.command = {
      command: "vscode.open",
      title: "Open journey",
      arguments: [makeAicUri(envName, realm, "journey", journeyId)]
    };
  }
}

export class EnvironmentsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly db: Database, private readonly globalStoragePath: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const active = getActiveEnvironment(this.db);
      return listEnvironments(this.db).map((env) => new EnvNode(env, env.name === active));
    }
    if (element instanceof EnvNode) {
      return listRealmsInLatest(this.globalStoragePath, element.env.name).map(
        (r) => new RealmNode(element.env.name, r)
      );
    }
    if (element instanceof RealmNode) {
      const count = listJourneysInLatest(this.globalStoragePath, element.envName, element.realm).length;
      return [new CategoryNode(element.envName, element.realm, "journeys", count)];
    }
    if (element instanceof CategoryNode) {
      return listJourneysInLatest(this.globalStoragePath, element.envName, element.realm).map(
        (id) => new JourneyNode(element.envName, element.realm, id)
      );
    }
    return [];
  }
}
