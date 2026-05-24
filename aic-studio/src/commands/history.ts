// src/commands/history.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { listOperations } from "../core/db/opHistory";
import { log } from "../logging/output";

type Deps = { db: Database };

export function registerHistoryCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.history.openDetails", (opId: number) =>
      openDetails(deps, opId)
    )
  );
}

async function openDetails(deps: Deps, opId: number): Promise<void> {
  const envs = listEnvironments(deps.db);
  for (const env of envs) {
    const ops = listOperations(deps.db, env.name, 1000);
    const op = ops.find((o) => o.id === opId);
    if (op) {
      const text =
        `Operation #${op.id}\n` +
        `Kind:        ${op.opKind}\n` +
        `Env:         ${op.envName}${op.targetEnv ? ` → ${op.targetEnv}` : ""}\n` +
        `Scope:       ${op.scope ?? "(none)"}\n` +
        `Status:      ${op.status}\n` +
        `Started:     ${new Date(op.startedAt).toISOString()}\n` +
        `Finished:    ${op.finishedAt ? new Date(op.finishedAt).toISOString() : "—"}\n` +
        `Snapshot:    ${op.snapshotDir ?? "(none)"}\n` +
        `\nMessage:\n${op.message ?? "(none)"}\n`;
      const doc = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
  }
  log(`history.openDetails: op ${opId} not found in any env`);
  void vscode.window.showWarningMessage(`Operation #${opId} not found.`);
}
