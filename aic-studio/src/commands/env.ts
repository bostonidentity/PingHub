// src/commands/env.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  insertEnvironment,
  listEnvironments,
  removeEnvironment,
  setActiveEnvironment,
  updateEnvironment
} from "../core/db/environments";
import { startOperation, finishOperation } from "../core/db/opHistory";
import { validateBundle, materializeEnvVars, type BundleV1 } from "../core/env/legacyBundle";
import { planConflicts, mapBundleEntryToEnvironment, mapBundleEntryToSecrets } from "../core/env/legacyImport";
import type { SecretKind } from "../core/env/secrets";
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
    vscode.commands.registerCommand("aic-studio.env.remove", () => removeEnvironmentCommand(deps)),
    vscode.commands.registerCommand("aic-studio.env.importFromLegacy", () => importFromLegacyCommand(deps))
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

async function importFromLegacyCommand(deps: Deps): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    filters: { JSON: ["json"] },
    canSelectMany: false,
    openLabel: "Import bundle",
    title: "Select aic-pipeline export bundle"
  });
  if (!uris?.length) return;
  const filePath = uris[0].fsPath;

  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf-8");
  } catch (e) {
    void vscode.window.showErrorMessage(`Failed to read file: ${(e as Error).message}`);
    return;
  }

  let bundle: BundleV1;
  try {
    const parsed = JSON.parse(raw);
    validateBundle(parsed);
    bundle = parsed;
  } catch (e) {
    void vscode.window.showErrorMessage(`Invalid bundle: ${(e as Error).message}`);
    return;
  }

  let passphrase: string | undefined;
  if (bundle.secretsEncryption === "passphrase-aes-256-gcm") {
    passphrase = await vscode.window.showInputBox({
      password: true,
      prompt: "Bundle passphrase",
      placeHolder: "Required to decrypt secrets",
      ignoreFocusOut: true
    });
    if (!passphrase) return;
  }

  const plan = planConflicts(deps.db, bundle.environments);
  type Item = vscode.QuickPickItem & { _idx: number };
  const selected = await vscode.window.showQuickPick<Item>(
    plan.map((p, i): Item => ({
      label: p.normalizedName,
      description: p.exists ? "exists — will prompt for action" : "new",
      detail: p.bundleName !== p.normalizedName ? `was: ${p.bundleName}` : undefined,
      picked: true,
      _idx: i
    })),
    { canPickMany: true, title: "Select environments to import" }
  );
  if (!selected?.length) return;

  type Decision = "skip" | "overwrite" | "rename" | "insert";
  const decisions = new Map<number, Decision>();
  const renames = new Map<number, string>();

  for (const item of selected) {
    const row = plan[item._idx];
    if (!row.exists) {
      decisions.set(item._idx, "insert");
      continue;
    }
    const action = await vscode.window.showQuickPick(
      [
        { label: "skip", description: "leave existing env unchanged" },
        { label: "overwrite", description: "replace existing env's config + secrets" },
        { label: "rename", description: "import under a new name" }
      ],
      { title: `Conflict for "${row.normalizedName}"` }
    );
    if (!action) return;
    if (action.label === "rename") {
      const newName = await vscode.window.showInputBox({
        prompt: "New name",
        value: `${row.normalizedName}-imported`,
        validateInput: (v) =>
          /^[a-z0-9][a-z0-9-_]*$/.test(v) ? null : "lowercase alphanumeric (with - or _)"
      });
      if (!newName) return;
      renames.set(item._idx, newName);
      decisions.set(item._idx, "rename");
    } else {
      decisions.set(item._idx, action.label as "skip" | "overwrite");
    }
  }

  let applied = 0, skipped = 0, failed = 0;
  const failures: string[] = [];

  for (const item of selected) {
    const idx = item._idx;
    const decision = decisions.get(idx);
    if (!decision || decision === "skip") {
      skipped++;
      continue;
    }
    const entry = bundle.environments[idx];
    const opId = startOperation(deps.db, { envName: entry.meta.name, opKind: "import-legacy" });
    try {
      const vars = materializeEnvVars(entry, bundle, passphrase);
      const { env, errors } = mapBundleEntryToEnvironment(entry, vars);
      if (!env) throw new Error(errors.join("; "));
      if (decision === "rename") env.name = renames.get(idx)!;
      if (decision === "overwrite") {
        updateEnvironment(deps.db, env);
      } else {
        insertEnvironment(deps.db, env);
      }
      const secrets = mapBundleEntryToSecrets(entry, vars);
      for (const [kind, val] of Object.entries(secrets) as Array<[SecretKind, string]>) {
        await deps.secrets.set(env.name, kind, val);
      }
      finishOperation(deps.db, opId, "success", `imported from ${path.basename(filePath)}`);
      applied++;
    } catch (e) {
      const msg = (e as Error).message;
      finishOperation(deps.db, opId, "failure", msg);
      failed++;
      failures.push(`${entry.meta.name}: ${msg}`);
    }
  }

  deps.onChange();

  const summary = `Imported ${applied} · skipped ${skipped} · failed ${failed}`;
  if (failed) {
    void vscode.window.showWarningMessage(summary, { detail: failures.join("\n"), modal: true });
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}
