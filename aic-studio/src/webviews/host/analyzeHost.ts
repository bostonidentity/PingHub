// src/webviews/host/analyzeHost.ts
import * as vscode from "vscode";
import { findUsage } from "../../core/analyze";
import { makeAicUri, makeAicFederationUri } from "../../providers/virtualDocs";
import { logError } from "../../logging/output";
import {
  AnalyzeWebviewMessageSchema,
  type AnalyzeOpenRequest,
  type AnalyzeResultResponse,
  type AnalyzeWebviewMessage,
  type AnalyzeOpenReferenceRequest
} from "./bridge";

export interface AnalyzeHostDeps {
  ctx: vscode.ExtensionContext;
  globalStoragePath: string;
}

export class AnalyzeHost {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: AnalyzeHostDeps) {}

  open(request: AnalyzeOpenRequest): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendResult(request);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "aic-studio.analyze",
      `Find Usage: ${request.target.realm}/${request.target.resourceType}/${request.target.id}`,
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
    this.sendResult(request);
  }

  private renderHtml(): string {
    if (!this.panel) return "";
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.ctx.extensionUri, "out", "webviews", "analyze", "main.js")
    );
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; font-src ${this.panel.webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Find Usage</title>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body>
</html>`;
  }

  private sendResult(request: AnalyzeOpenRequest): void {
    if (!this.panel) return;
    const result = findUsage(this.deps.globalStoragePath, request.envName, request.target);
    const payload: AnalyzeResultResponse = {
      kind: "analyze-result",
      envName: request.envName,
      target: result.target,
      refs: result.refs.map((r) => ({ source: r.source, target: r.target, detail: r.detail }))
    };
    void this.panel.webview.postMessage(payload);
  }

  private handleMessage(raw: unknown): void {
    const parsed = AnalyzeWebviewMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logError("analyzeHost: invalid message", parsed.error);
      return;
    }
    const msg: AnalyzeWebviewMessage = parsed.data;
    if (msg.kind === "analyze-open-reference") {
      this.openReference(msg);
    }
  }

  private openReference(msg: AnalyzeOpenReferenceRequest): void {
    const { envName, ref } = msg;
    if (ref.resourceType === "journey") {
      void vscode.commands.executeCommand("vscode.open", makeAicUri(envName, ref.realm, "journey", ref.id));
    } else if (ref.resourceType === "saml2" || ref.resourceType === "OAuth2Client") {
      void vscode.commands.executeCommand("vscode.open", makeAicFederationUri(envName, ref.realm, ref.resourceType, ref.id));
    } else {
      // script — no virtual doc handler yet; show info message
      void vscode.window.showInformationMessage(`Scripts not yet openable as virtual docs (${ref.realm}/${ref.id})`);
    }
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
