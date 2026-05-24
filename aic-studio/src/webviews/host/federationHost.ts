// src/webviews/host/federationHost.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { readFederationFromLatest } from "../../core/snapshots/reader";
import type { SecretStore } from "../../core/env/secrets";
import { log, logError } from "../../logging/output";
import {
  WebviewMessageSchema,
  type LoadResponse,
  type OpenRequest,
  type SaveResponse,
  type WebviewMessage
} from "./bridge";

export interface FederationHostDeps {
  ctx: vscode.ExtensionContext;
  db: Database;
  secrets: SecretStore;
  globalStoragePath: string;
  onChange: () => void;
}

export class FederationEditorHost {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: FederationHostDeps) {}

  open(request: OpenRequest): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendOpenLoad(request);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "aic-studio.federationEditor",
      `Federation: ${request.realm}/${request.federationType}/${request.id}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.deps.ctx.extensionUri, "out", "webviews")
        ]
      }
    );
    this.deps.ctx.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m));
    this.sendOpenLoad(request);
  }

  private renderHtml(): string {
    if (!this.panel) return "";
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.ctx.extensionUri, "out", "webviews", "federation-editor", "main.js")
    );
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; font-src ${this.panel.webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Federation Editor</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private sendOpenLoad(request: OpenRequest): void {
    if (!this.panel) return;
    const body = readFederationFromLatest(
      this.deps.globalStoragePath, request.envName, request.realm, request.federationType, request.id
    );
    const payload: LoadResponse = {
      kind: "load",
      envName: request.envName,
      realm: request.realm,
      federationType: request.federationType,
      id: request.id,
      body: body ?? null
    };
    void this.panel.webview.postMessage(payload);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const parsed = WebviewMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logError("federationHost: invalid webview message", parsed.error);
      return;
    }
    const msg: WebviewMessage = parsed.data;
    if (msg.kind === "ready") {
      return;
    }
    if (msg.kind === "save") {
      await this.handleSave(msg);
    }
  }

  private async handleSave(msg: { envName: string; realm: string; federationType: string; id: string; body: Record<string, unknown> }): Promise<void> {
    // M7 ships the editor + read; full save-roundtrip flow comes in M7.1
    log(`federation save requested but full save flow is deferred to M7.1: ${msg.envName} ${msg.realm}/${msg.federationType}/${msg.id}`);
    this.sendSaveResult({
      kind: "save-result",
      ok: false,
      error: "Saving from the federation editor is not yet implemented; manual edit + push via promotion task is required for now."
    });
  }

  private sendSaveResult(payload: SaveResponse): void {
    if (this.panel) {
      void this.panel.webview.postMessage(payload);
    }
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
