// src/webviews/host/dashboardHost.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { buildDashboardSummary } from "../../core/dashboard/summary";
import { logError } from "../../logging/output";
import { DashboardRefreshRequestSchema, type DashboardSummaryResponse } from "./bridge";

export interface DashboardHostDeps {
  ctx: vscode.ExtensionContext;
  db: Database;
  globalStoragePath: string;
}

export class DashboardHost {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: DashboardHostDeps) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendSummary();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "aic-studio.dashboard",
      "AIC Studio: Dashboard",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.deps.ctx.extensionUri, "out", "webviews")]
      }
    );
    this.deps.ctx.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m));
    this.sendSummary();
  }

  refresh(): void {
    if (this.panel) this.sendSummary();
  }

  private renderHtml(): string {
    if (!this.panel) return "";
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.ctx.extensionUri, "out", "webviews", "dashboard", "main.js")
    );
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; font-src ${this.panel.webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Dashboard</title>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body>
</html>`;
  }

  private sendSummary(): void {
    if (!this.panel) return;
    const summary = buildDashboardSummary(this.deps.db, this.deps.globalStoragePath);
    const payload: DashboardSummaryResponse = {
      kind: "dashboard-summary",
      envs: summary.envs,
      totalRecentOps: summary.totalRecentOps,
      totalAlerts: summary.totalAlerts
    };
    void this.panel.webview.postMessage(payload);
  }

  private handleMessage(raw: unknown): void {
    const parsed = DashboardRefreshRequestSchema.safeParse(raw);
    if (parsed.success) {
      this.sendSummary();
      return;
    }
    logError("dashboardHost: invalid message", new Error("invalid"));
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
