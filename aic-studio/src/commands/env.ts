// src/commands/env.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  insertEnvironment,
  listEnvironments,
  removeEnvironment,
  setActiveEnvironment
} from "../core/db/environments";
import type { SecretStore } from "../core/env/secrets";
import { NewEnvironmentSchema, type NewEnvironment, EnvironmentColor } from "../core/env/types";
import { log, logError } from "../logging/output";

type Deps = {
  db: Database;
  secrets: SecretStore;
  onChange: () => void;
};

export function registerEnvCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.env.add", () => addEnvironmentCommand(deps)),
    vscode.commands.registerCommand("aic-studio.env.setActive", () => setActiveCommand(deps)),
    vscode.commands.registerCommand("aic-studio.env.remove", () => removeEnvironmentCommand(deps))
  );
}

async function addEnvironmentCommand(deps: Deps): Promise<void> {
  try {
    const name = await vscode.window.showInputBox({
      prompt: "Environment name (lowercase, alphanumeric + - _)",
      placeHolder: "prod-tenant",
      validateInput: (v) => /^[a-z0-9][a-z0-9-_]*$/.test(v) ? null : "lowercase alphanumeric only"
    });
    if (!name) return;

    const label = await vscode.window.showInputBox({
      prompt: "Display label",
      placeHolder: "Production",
      value: name
    });
    if (!label) return;

    const tenantUrl = await vscode.window.showInputBox({
      prompt: "Tenant URL",
      placeHolder: "https://prod.id.forgerock.io",
      validateInput: (v) => { try { new URL(v); return null; } catch { return "must be a valid URL"; } }
    });
    if (!tenantUrl) return;

    const username = await vscode.window.showInputBox({
      prompt: "Service-account username",
      placeHolder: "service-account@example.com"
    });
    if (!username) return;

    const clientId = await vscode.window.showInputBox({
      prompt: "OAuth client ID"
    });
    if (!clientId) return;

    const color = await vscode.window.showQuickPick(EnvironmentColor.options, {
      placeHolder: "Color (used in sidebar / status bar)"
    }) as NewEnvironment["color"] | undefined;
    if (!color) return;

    const password = await vscode.window.showInputBox({
      prompt: "Service-account password (stored in OS keychain)",
      password: true
    });
    if (password === undefined) return;

    const clientSecret = await vscode.window.showInputBox({
      prompt: "OAuth client secret (stored in OS keychain)",
      password: true
    });
    if (clientSecret === undefined) return;

    const env = NewEnvironmentSchema.parse({ name, label, tenantUrl, username, clientId, color });
    insertEnvironment(deps.db, env);
    await deps.secrets.set(name, "password", password);
    await deps.secrets.set(name, "client-secret", clientSecret);

    log(`Added environment: ${name}`);
    deps.onChange();
    void vscode.window.showInformationMessage(`Added AIC environment "${label}"`);
  } catch (err) {
    logError("env.add failed", err);
    void vscode.window.showErrorMessage(`Add environment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function setActiveCommand(deps: Deps): Promise<void> {
  const envs = listEnvironments(deps.db);
  if (envs.length === 0) {
    void vscode.window.showInformationMessage("No environments configured. Run 'AIC Studio: Add environment…' first.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Select active environment" }
  );
  if (!pick) return;
  setActiveEnvironment(deps.db, pick.name);
  log(`Active environment: ${pick.name}`);
  deps.onChange();
}

async function removeEnvironmentCommand(deps: Deps): Promise<void> {
  const envs = listEnvironments(deps.db);
  if (envs.length === 0) {
    void vscode.window.showInformationMessage("No environments to remove.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Select environment to remove" }
  );
  if (!pick) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove environment "${pick.label}"? Credentials in the OS keychain are also deleted.`,
    { modal: true },
    "Remove"
  );
  if (confirm !== "Remove") return;

  removeEnvironment(deps.db, pick.name);
  await deps.secrets.deleteAll(pick.name);
  log(`Removed environment: ${pick.name}`);
  deps.onChange();
  void vscode.window.showInformationMessage(`Removed "${pick.label}"`);
}
