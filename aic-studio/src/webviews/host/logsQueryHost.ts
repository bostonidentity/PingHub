// src/webviews/host/logsQueryHost.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { getEnvironmentByName } from "../../core/db/environments";
import { getSavedQuery, saveQuery, updateLastRun } from "../../core/db/savedLogQueries";
import { queryLogs } from "../../core/aic/logs";
import type { SecretStore } from "../../core/env/secrets";
import { log, logError } from "../../logging/output";
import {
  LogsWebviewMessageSchema,
  type LogsOpenRequest,
  type LogsQueryResponse,
  type LogsRunQueryRequest,
  type LogsSaveQueryRequest,
  type LogsSaveResponse,
  type LogsWebviewMessage
} from "./bridge";

export interface LogsQueryHostDeps {
  ctx: vscode.ExtensionContext;
  db: Database;
  secrets: SecretStore;
  onChange: () => void;
}

export class LogsQueryHost {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: LogsQueryHostDeps) {}

  open(envName: string, savedQueryId?: number): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendOpen(envName, savedQueryId);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "aic-studio.logsQuery",
      `Logs: ${envName}`,
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
    this.sendOpen(envName, savedQueryId);
  }

  private renderHtml(): string {
    if (!this.panel) return "";
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.ctx.extensionUri, "out", "webviews", "logs-query", "main.js")
    );
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; font-src ${this.panel.webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Logs Query</title>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body>
</html>`;
  }

  private sendOpen(envName: string, savedQueryId?: number): void {
    if (!this.panel) return;
    const payload: LogsOpenRequest = {
      kind: "logs-open",
      envName
    };
    if (savedQueryId !== undefined) {
      const q = getSavedQuery(this.deps.db, savedQueryId);
      if (q) {
        payload.savedQuery = {
          id: q.id,
          name: q.name,
          source: q.source,
          filterExpr: q.filterExpr
        };
      }
    }
    void this.panel.webview.postMessage(payload);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const parsed = LogsWebviewMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logError("logsQueryHost: invalid message", parsed.error);
      return;
    }
    const msg: LogsWebviewMessage = parsed.data;
    if (msg.kind === "logs-run") {
      await this.handleRun(msg);
    } else if (msg.kind === "logs-save") {
      await this.handleSave(msg);
    }
  }

  private async handleRun(msg: LogsRunQueryRequest): Promise<void> {
    const env = getEnvironmentByName(this.deps.db, msg.envName);
    if (!env) {
      this.sendQueryResult({ kind: "logs-result", ok: false, error: `Unknown env: ${msg.envName}` });
      return;
    }
    const apiKey = await this.deps.secrets.get(msg.envName, "log-api-key");
    const apiSecret = await this.deps.secrets.get(msg.envName, "log-api-secret");
    if (!apiKey || !apiSecret) {
      this.sendQueryResult({ kind: "logs-result", ok: false, error: "Log API credentials not set for this env." });
      return;
    }
    try {
      const result = await queryLogs({
        tenantUrl: env.tenantUrl,
        apiKey,
        apiSecret,
        source: msg.source,
        filterExpr: msg.filterExpr,
        pageSize: msg.pageSize,
        beginTime: msg.beginTime,
        endTime: msg.endTime
      });
      log(`logs query: ${msg.envName} ${msg.source} → ${result.entries.length} entries`);
      this.sendQueryResult({ kind: "logs-result", ok: true, entries: result.entries });
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      logError("logs query failed", err);
      this.sendQueryResult({ kind: "logs-result", ok: false, error: msgText });
    }
  }

  private async handleSave(msg: LogsSaveQueryRequest): Promise<void> {
    try {
      const id = saveQuery(this.deps.db, {
        envName: msg.envName,
        name: msg.name,
        source: msg.source,
        filterExpr: msg.filterExpr
      });
      updateLastRun(this.deps.db, id);
      log(`logs: saved query "${msg.name}" for ${msg.envName} (id=${id})`);
      this.sendSaveResult({ kind: "logs-save-result", ok: true, id });
      this.deps.onChange();
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      logError("logs save failed", err);
      this.sendSaveResult({ kind: "logs-save-result", ok: false, error: msgText });
    }
  }

  private sendQueryResult(payload: LogsQueryResponse): void {
    if (this.panel) void this.panel.webview.postMessage(payload);
  }

  private sendSaveResult(payload: LogsSaveResponse): void {
    if (this.panel) void this.panel.webview.postMessage(payload);
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
