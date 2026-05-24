// src/providers/historyTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { listOperations, type OpRow } from "../core/db/opHistory";

type Node = DayNode | OpNode;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class DayNode extends vscode.TreeItem {
  constructor(public readonly day: string, public readonly ops: OpRow[]) {
    super(day, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `day:${day}`;
    this.description = `${ops.length} op${ops.length === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon("calendar");
  }
}

export class OpNode extends vscode.TreeItem {
  constructor(public readonly op: OpRow) {
    const time = new Date(op.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    super(
      `${time}  ${op.opKind} ${op.envName}${op.targetEnv ? ` → ${op.targetEnv}` : ""}`,
      vscode.TreeItemCollapsibleState.None
    );
    this.id = `op:${op.id}`;
    this.description = op.status + (op.scope ? `  ${op.scope}` : "");
    const iconName = op.status === "success" ? "pass" : op.status === "failure" ? "error" : "sync~spin";
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.tooltip = new vscode.MarkdownString(
      `**${op.opKind}** ${op.scope ?? ""} \\\n` +
      `Env: \`${op.envName}\`${op.targetEnv ? ` → \`${op.targetEnv}\`` : ""} \\\n` +
      `Status: ${op.status} \\\n` +
      `Started: ${new Date(op.startedAt).toLocaleString()}${op.finishedAt ? ` \\\nFinished: ${new Date(op.finishedAt).toLocaleString()}` : ""} \\\n` +
      (op.message ? `\n\`\`\`\n${op.message}\n\`\`\`` : "")
    );
    this.command = {
      command: "aic-studio.history.openDetails",
      title: "Show operation details",
      arguments: [op.id]
    };
  }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<Node> {
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
      const envs = listEnvironments(this.db);
      const allOps: OpRow[] = [];
      for (const env of envs) {
        allOps.push(...listOperations(this.db, env.name, 200));
      }
      const byDay = new Map<string, OpRow[]>();
      for (const op of allOps) {
        const key = dayKey(op.startedAt);
        const arr = byDay.get(key) ?? [];
        arr.push(op);
        byDay.set(key, arr);
      }
      return Array.from(byDay.entries())
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([day, ops]) => new DayNode(day, ops));
    }
    if (element instanceof DayNode) {
      return element.ops
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((op) => new OpNode(op));
    }
    return [];
  }
}
