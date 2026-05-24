// src/providers/envTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments, getActiveEnvironment } from "../core/db/environments";
import type { Environment } from "../core/env/types";
import { listRealmsInLatest, listJourneysInLatest, listFederationTypesInLatest, listFederationIdsInLatest } from "../core/snapshots/reader";
import { makeAicUri, makeAicFederationUri } from "./virtualDocs";

type TreeNode = EnvNode | RealmNode | CategoryNode | JourneyNode | FederationCategoryNode | FederationTypeNode | FederationItemNode;

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

export class FederationCategoryNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string, count: number) {
    super(`Federation (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `fed-cat:${envName}:${realm}`;
    this.contextValue = "aic-studio.federationCategory";
    this.iconPath = new vscode.ThemeIcon("link");
  }
}

export class FederationTypeNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string, public readonly type: string, count: number) {
    super(`${type} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `fed-type:${envName}:${realm}:${type}`;
    this.contextValue = "aic-studio.federationType";
    this.iconPath = new vscode.ThemeIcon("symbol-class");
  }
}

export class FederationItemNode extends vscode.TreeItem {
  constructor(public readonly envName: string, public readonly realm: string, public readonly fedType: string, public readonly itemId: string) {
    super(itemId, vscode.TreeItemCollapsibleState.None);
    this.id = `fed-item:${envName}:${realm}:${fedType}:${itemId}`;
    this.contextValue = "aic-studio.federationItem";
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [makeAicFederationUri(envName, realm, fedType, itemId)]
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
      const jcount = listJourneysInLatest(this.globalStoragePath, element.envName, element.realm).length;
      const fedTypes = listFederationTypesInLatest(this.globalStoragePath, element.envName, element.realm);
      const fedCount = fedTypes.reduce(
        (a, t) => a + listFederationIdsInLatest(this.globalStoragePath, element.envName, element.realm, t).length,
        0
      );
      const nodes: TreeNode[] = [new CategoryNode(element.envName, element.realm, "journeys", jcount)];
      if (fedTypes.length > 0) {
        nodes.push(new FederationCategoryNode(element.envName, element.realm, fedCount));
      }
      return nodes;
    }
    if (element instanceof CategoryNode) {
      return listJourneysInLatest(this.globalStoragePath, element.envName, element.realm).map(
        (id) => new JourneyNode(element.envName, element.realm, id)
      );
    }
    if (element instanceof FederationCategoryNode) {
      return listFederationTypesInLatest(this.globalStoragePath, element.envName, element.realm).map(
        (t) => new FederationTypeNode(element.envName, element.realm, t, listFederationIdsInLatest(this.globalStoragePath, element.envName, element.realm, t).length)
      );
    }
    if (element instanceof FederationTypeNode) {
      return listFederationIdsInLatest(this.globalStoragePath, element.envName, element.realm, element.type).map(
        (id) => new FederationItemNode(element.envName, element.realm, element.type, id)
      );
    }
    return [];
  }
}
