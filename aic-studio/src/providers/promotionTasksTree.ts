// src/providers/promotionTasksTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  listActiveTasks,
  listItemsInTask,
  type PromotionTaskRow,
  type TaskItem
} from "../core/db/promotionTasks";

type Node = TaskNode | ItemNode;

export class TaskNode extends vscode.TreeItem {
  constructor(public readonly task: PromotionTaskRow) {
    super(task.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `promotion-task:${task.id}`;
    this.contextValue = "aic-studio.promotionTask";
    this.description = `from ${task.sourceEnv}`;
    this.iconPath = new vscode.ThemeIcon("rocket");
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
      return listActiveTasks(this.db).map((t) => new TaskNode(t));
    }
    if (element instanceof TaskNode) {
      return listItemsInTask(this.db, element.task.id).map((i) => new ItemNode(element.task.id, i));
    }
    return [];
  }
}
