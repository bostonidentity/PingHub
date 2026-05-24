// src/commands/monitor.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments, getEnvironmentByName } from "../core/db/environments";
import type { SecretStore } from "../core/env/secrets";
import { checkTls } from "../core/monitors/tls";
import { checkServerPing } from "../core/monitors/serverPing";
import { recordCheck, recordAlert, acknowledgeAlert, type CheckStatus, type AlertSeverity } from "../core/db/monitorChecks";
import { log, logError } from "../logging/output";
import type { AlertNode } from "../providers/monitorsTree";

type Deps = {
  db: Database;
  secrets: SecretStore;
  onChange: () => void;
  openDashboard: () => void;
};

export function registerMonitorCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.monitor.pollNow", () => pollNow(deps)),
    vscode.commands.registerCommand("aic-studio.monitor.openDashboard", () => deps.openDashboard()),
    vscode.commands.registerCommand("aic-studio.monitor.acknowledgeAlert", (node?: AlertNode) =>
      acknowledgeCmd(deps, node)
    )
  );
}

async function pollNow(deps: Deps): Promise<void> {
  const envs = listEnvironments(deps.db);
  if (envs.length === 0) {
    void vscode.window.showInformationMessage("No environments to monitor.");
    return;
  }
  log(`monitor.pollNow: checking ${envs.length} envs`);
  for (const env of envs) {
    await checkOneEnv(deps, env.name);
  }
  deps.onChange();
  void vscode.window.showInformationMessage(`Checked ${envs.length} env${envs.length === 1 ? "" : "s"}`);
}

export async function checkOneEnv(deps: Deps, envName: string): Promise<void> {
  const env = getEnvironmentByName(deps.db, envName);
  if (!env) return;

  // TLS check (host from tenant URL)
  try {
    const tenantHost = new URL(env.tenantUrl).hostname;
    const tls = await checkTls(tenantHost);
    const status: CheckStatus = !tls.ok ? "error" : tls.daysRemaining < 14 ? "error" : tls.daysRemaining < 30 ? "warning" : "ok";
    recordCheck(deps.db, {
      envName,
      checkType: "tls",
      status,
      detail: tls.ok ? `${tls.subject} expires ${tls.validTo.toISOString()}` : tls.error,
      daysRemaining: tls.ok ? tls.daysRemaining : undefined
    });
    if (status === "warning" || status === "error") {
      const sev: AlertSeverity = status === "error" ? "error" : "warning";
      recordAlert(deps.db, { envName, checkType: "tls", severity: sev, message: `TLS: ${tls.ok ? `${tls.daysRemaining}d remaining` : tls.error ?? "check failed"}` });
    }
  } catch (err) {
    logError(`tls check failed for ${envName}`, err);
    recordCheck(deps.db, { envName, checkType: "tls", status: "error", detail: err instanceof Error ? err.message : String(err) });
  }

  // Server ping check (OAuth roundtrip)
  try {
    const clientSecret = await deps.secrets.get(envName, "client-secret");
    if (clientSecret) {
      const ping = await checkServerPing({
        tenantUrl: env.tenantUrl,
        clientId: env.clientId,
        clientSecret
      });
      const status: CheckStatus = ping.ok ? "ok" : "error";
      recordCheck(deps.db, {
        envName,
        checkType: "ping",
        status,
        detail: ping.ok ? `${ping.latencyMs}ms` : ping.error
      });
      if (!ping.ok) {
        recordAlert(deps.db, { envName, checkType: "ping", severity: "error", message: `Ping: ${ping.error ?? "failed"}` });
      }
    } else {
      recordCheck(deps.db, { envName, checkType: "ping", status: "error", detail: "no client-secret configured" });
    }
  } catch (err) {
    logError(`ping check failed for ${envName}`, err);
    recordCheck(deps.db, { envName, checkType: "ping", status: "error", detail: err instanceof Error ? err.message : String(err) });
  }
}

async function acknowledgeCmd(deps: Deps, node?: AlertNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage("Right-click an alert in the Monitors view to acknowledge it.");
    return;
  }
  acknowledgeAlert(deps.db, node.alert.id);
  log(`monitor.acknowledgeAlert: ${node.alert.id}`);
  deps.onChange();
}
