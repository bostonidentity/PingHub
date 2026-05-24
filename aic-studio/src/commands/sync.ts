// src/commands/sync.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  getActiveEnvironment,
  getEnvironmentByName,
  listEnvironments
} from "../core/db/environments";
import type { SecretStore } from "../core/env/secrets";
import { createTokenCache, fetchAccessToken } from "../core/aic/auth";
import { pullAllJourneys } from "../core/pull/pullJourneys";
import { startOperation, finishOperation } from "../core/db/opHistory";
import type { PullProgressStatusBar } from "../status/pullProgress";
import { log, logError } from "../logging/output";

type Deps = {
  db: Database;
  secrets: SecretStore;
  globalStoragePath: string;
  pullStatus: PullProgressStatusBar;
  onChange: () => void;
};

export function registerSyncCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.sync.pull", (envNameArg?: string) =>
      pullCommand(deps, envNameArg)
    )
  );
}

async function pullCommand(deps: Deps, envNameArg?: string): Promise<void> {
  const envName = envNameArg ?? (await pickEnv(deps));
  if (!envName) return;

  const env = getEnvironmentByName(deps.db, envName);
  if (!env) {
    void vscode.window.showErrorMessage(`Unknown environment: ${envName}`);
    return;
  }
  const password = await deps.secrets.get(envName, "client-secret");
  if (!password) {
    void vscode.window.showErrorMessage(
      `No client secret configured for "${envName}". Use 'AIC Studio: Add environment…' to (re)configure.`
    );
    return;
  }

  const opId = startOperation(deps.db, { envName, opKind: "pull", scope: "journeys" });
  deps.pullStatus.show(envName, "authenticating…");
  log(`pull start: ${envName}`);

  try {
    const tokenCache = createTokenCache(() =>
      fetchAccessToken({
        tenantUrl: env.tenantUrl,
        clientId: env.clientId,
        clientSecret: password
      })
    );
    deps.pullStatus.show(envName, "fetching journeys…");
    const result = await pullAllJourneys({
      tenantUrl: env.tenantUrl,
      tokenCache,
      envName,
      globalStoragePath: deps.globalStoragePath
    });

    finishOperation(
      deps.db,
      opId,
      "success",
      `pulled ${result.journeyCount} journeys from ${result.realmCount} realms`
    );
    log(`pull success: ${envName} → ${result.journeyCount} journeys`);
    void vscode.window.showInformationMessage(
      `Pulled ${result.journeyCount} journeys from "${env.label}"`
    );
    deps.onChange();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishOperation(deps.db, opId, "failure", msg);
    logError(`pull failed: ${envName}`, err);
    void vscode.window.showErrorMessage(`Pull failed: ${msg}`);
  } finally {
    deps.pullStatus.hide();
  }
}

async function pickEnv(deps: Deps): Promise<string | undefined> {
  const active = getActiveEnvironment(deps.db);
  if (active) return active;
  const envs = listEnvironments(deps.db);
  if (envs.length === 0) {
    void vscode.window.showInformationMessage("No environments configured.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Pull from which environment?" }
  );
  return pick?.name;
}
