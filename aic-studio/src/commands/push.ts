// src/commands/push.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  getEnvironmentByName,
  listEnvironments
} from "../core/db/environments";
import type { SecretStore } from "../core/env/secrets";
import { createTokenCache, fetchAccessToken } from "../core/aic/auth";
import { pushJourneyFromSnapshot } from "../core/push/pushJourney";
import { startOperation, finishOperation } from "../core/db/opHistory";
import type { JourneyNode } from "../providers/envTree";
import { log, logError } from "../logging/output";

type Deps = {
  db: Database;
  secrets: SecretStore;
  globalStoragePath: string;
  onChange: () => void;
};

export function registerPushCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.sync.push", (node?: JourneyNode) =>
      pushCommand(deps, node)
    )
  );
}

async function pushCommand(deps: Deps, node?: JourneyNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage(
      "Right-click a journey in the Environments tree, then 'Push to environment…'."
    );
    return;
  }
  const others = listEnvironments(deps.db).filter((e) => e.name !== node.envName);
  if (others.length === 0) {
    void vscode.window.showInformationMessage("No other environment to push to.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    others.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: `Push ${node.realm}/${node.journeyId} from ${node.envName} to…` }
  );
  if (!pick) return;

  const targetEnv = getEnvironmentByName(deps.db, pick.name);
  if (!targetEnv) return;
  const clientSecret = await deps.secrets.get(pick.name, "client-secret");
  if (!clientSecret) {
    void vscode.window.showErrorMessage(
      `No client secret configured for "${pick.name}".`
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Push ${node.realm}/${node.journeyId} → "${targetEnv.label}"?`,
    { modal: true },
    "Push"
  );
  if (confirm !== "Push") return;

  const opId = startOperation(deps.db, {
    envName: pick.name,
    opKind: "push",
    scope: `journey:${node.realm}/${node.journeyId}`
  });
  log(`push start: ${node.envName} → ${pick.name} ${node.realm}/${node.journeyId}`);

  try {
    const tokenCache = createTokenCache(() =>
      fetchAccessToken({
        tenantUrl: targetEnv.tenantUrl,
        clientId: targetEnv.clientId,
        clientSecret
      })
    );
    await pushJourneyFromSnapshot({
      globalStoragePath: deps.globalStoragePath,
      sourceEnvName: node.envName,
      targetTenantUrl: targetEnv.tenantUrl,
      targetTokenCache: tokenCache,
      realm: node.realm,
      journeyId: node.journeyId
    });
    finishOperation(deps.db, opId, "success", `pushed ${node.realm}/${node.journeyId}`);
    log(`push success: ${pick.name} ${node.realm}/${node.journeyId}`);
    void vscode.window.showInformationMessage(
      `Pushed ${node.realm}/${node.journeyId} to "${targetEnv.label}"`
    );
    deps.onChange();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishOperation(deps.db, opId, "failure", msg);
    logError(`push failed`, err);
    void vscode.window.showErrorMessage(`Push failed: ${msg}`);
  }
}
