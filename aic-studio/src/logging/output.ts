// src/logging/output.ts
import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("AIC Studio");
  ctx.subscriptions.push(channel);
}

function ts(): string {
  return new Date().toISOString();
}

export function log(message: string): void {
  channel?.appendLine(`${ts()} ${message}`);
}

export function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  channel?.appendLine(`${ts()} ERROR ${message}: ${detail}`);
}
