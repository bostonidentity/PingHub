// src/status/pullProgress.ts
import * as vscode from "vscode";

export class PullProgressStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(ctx: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    ctx.subscriptions.push(this.item);
  }

  show(envName: string, message: string): void {
    this.item.text = `$(sync~spin) ${envName}: ${message}`;
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }
}
