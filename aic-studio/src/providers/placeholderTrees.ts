// src/providers/placeholderTrees.ts
import * as vscode from "vscode";

class PlaceholderProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly placeholderText: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem(this.placeholderText, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("info");
    return [item];
  }
}

export const promotionTasksTree = new PlaceholderProvider("Coming in milestone 6");
export const historyTree = new PlaceholderProvider("Coming in milestone 5");
export const monitorsTree = new PlaceholderProvider("Coming in milestone 8");
export const logsTree = new PlaceholderProvider("Coming in milestone 9");
