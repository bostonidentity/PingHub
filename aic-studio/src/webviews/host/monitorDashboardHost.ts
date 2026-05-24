// src/webviews/host/monitorDashboardHost.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../../core/db/environments";
import { latestCheck, listActiveAlerts } from "../../core/db/monitorChecks";
import { logError } from "../../logging/output";
import { MonitorRefreshRequestSchema, type MonitorSummaryItem, type MonitorSummaryResponse } from "./bridge";

export interface MonitorDashboardDeps {
  ctx: vscode.ExtensionContext;
  db: Database;
}

export class MonitorDashboardHost {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: MonitorDashboardDeps) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendSummary();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "aic-studio.monitorDashboard",
      "AIC Studio: Monitor Dashboard",
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
      vscode.Uri.joinPath(this.deps.ctx.extensionUri, "out", "webviews", "monitor-dashboard", "main.js")
    );
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; font-src ${this.panel.webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Monitor Dashboard</title>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body>
</html>`;
  }

  private sendSummary(): void {
    if (!this.panel) return;
    const envs = listEnvironments(this.deps.db);
    const items: MonitorSummaryItem[] = envs.map((env) => {
      const tls = latestCheck(this.deps.db, env.name, "tls");
      const ping = latestCheck(this.deps.db, env.name, "ping");
      return {
        envName: env.name,
        envLabel: env.label,
        tls: tls ? { status: tls.status, daysRemaining: tls.daysRemaining, detail: tls.detail, checkedAt: tls.checkedAt } : undefined,
        ping: ping ? { status: ping.status, detail: ping.detail, checkedAt: ping.checkedAt } : undefined,
        alertCount: listActiveAlerts(this.deps.db, env.name).length
      };
    });
    const payload: MonitorSummaryResponse = { kind: "monitor-summary", items };
    void this.panel.webview.postMessage(payload);
  }

  private handleMessage(raw: unknown): void {
    const parsed = MonitorRefreshRequestSchema.safeParse(raw);
    if (parsed.success) {
      this.sendSummary();
      return;
    }
    logError("monitorDashboardHost: invalid message", new Error("invalid"));
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
