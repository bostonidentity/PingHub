// src/providers/promotionTasksTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  listActiveTasks,
  listArchivedTasks,
  listItemsInTask,
  type PromotionTaskRow,
  type TaskItem
} from "../core/db/promotionTasks";

type Node = ArchivedRootNode | TaskNode | ItemNode;

export class ArchivedRootNode extends vscode.TreeItem {
  constructor(count: number) {
    super(`Archived (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "archived-root";
    this.contextValue = "aic-studio.archivedRoot";
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

export class TaskNode extends vscode.TreeItem {
  constructor(public readonly task: PromotionTaskRow) {
    super(task.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `promotion-task:${task.id}`;
    this.contextValue = task.status === "archived" ? "aic-studio.archivedTask" : "aic-studio.promotionTask";
    this.description = `from ${task.sourceEnv}`;
    this.iconPath = new vscode.ThemeIcon(task.status === "archived" ? "archive" : "rocket");
  }
}

export class ItemNode extends vscode.TreeItem {
  constructor(public readonly taskId: number, public readonly item: TaskItem) {
    super(`${item.realm} / ${item.resourceType} / ${item.resourceId}`, vscode.TreeItemCollapsibleState.None);
    this.id = `promotion-task-item:${taskId}:${item.realm}:${item.resourceType}:${item.resourceId}`;
    this.contextValue = "aic-studio.promotionTaskItem";
    this.iconPath = new vscode.ThemeIcon("file-code");
  }
}

export class PromotionTasksTreeProvider implements vscode.TreeDataProvider<Node> {
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
      const active = listActiveTasks(this.db);
      const archivedCount = listArchivedTasks(this.db).length;
      const nodes: Node[] = active.map((t) => new TaskNode(t));
      if (archivedCount > 0) nodes.push(new ArchivedRootNode(archivedCount));
      return nodes;
    }
    if (element instanceof ArchivedRootNode) {
      return listArchivedTasks(this.db).map((t) => new TaskNode(t));
    }
    if (element instanceof TaskNode) {
      return listItemsInTask(this.db, element.task.id).map((i) => new ItemNode(element.task.id, i));
    }
    return [];
  }
}
