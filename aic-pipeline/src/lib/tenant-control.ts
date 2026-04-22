/**
 * In-process tenant-control helpers — restart and direct-control session
 * lifecycle. Replaces shelling out to `fr-config-push restart` /
 * `fr-config-push direct-control-*` so the UI works without the upstream
 * CLI installed.
 *
 * Endpoints (relative to TENANT_BASE_URL), per upstream
 * @forgerock/fr-config-manager v1.5.12:
 *
 *   POST /environment/startup                      body: {_action:"restart"}
 *   GET  /environment/startup                      → { restartStatus: "ready"|"restarting"|… }
 *   GET  /environment/direct-configuration/session/state  → { status, editable, … }
 *   PUT  /environment/direct-configuration/session/init
 *   PUT  /environment/direct-configuration/session/apply
 *   PUT  /environment/direct-configuration/session/abort
 *
 * Auth: the same OAuth bearer used by the rest of the in-process scopes
 * (see iga-api.ts → getAccessToken).
 */

import { getAccessToken } from "./iga-api";
import { getEnvFileContent } from "./fr-config";
import { parseEnvFile } from "./env-parser";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const RESTART_API_VERSION = "protocol=1.0,resource=1.0";

async function bootstrap(environment: string): Promise<{ tenantUrl: string; token: string }> {
  const envContent = getEnvFileContent(environment);
  if (!envContent) throw new Error(`No .env file for environment "${environment}"`);
  const envVars = parseEnvFile(envContent);
  const tenantUrl = (envVars.TENANT_BASE_URL ?? "").replace(/\/$/, "");
  if (!tenantUrl) throw new Error("TENANT_BASE_URL is not set in this environment's .env");
  const token = await getAccessToken(envVars);
  return { tenantUrl, token };
}

function err(e: unknown): CommandResult {
  return { stdout: "", stderr: e instanceof Error ? e.message : String(e), exitCode: 1 };
}

async function readBody(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

// ── /environment/startup ─────────────────────────────────────────────────────

export async function restartTenant(environment: string): Promise<CommandResult> {
  try {
    const { tenantUrl, token } = await bootstrap(environment);
    // _action is a query parameter on this endpoint, not a body field.
    const res = await fetch(`${tenantUrl}/environment/startup?_action=restart`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-API-Version": RESTART_API_VERSION,
        "Content-Type": "application/json",
      },
    });
    const body = await readBody(res);
    if (!res.ok) return { stdout: "", stderr: `HTTP ${res.status}: ${body}`, exitCode: 1 };
    return { stdout: "Environment restart initiated.\n", stderr: "", exitCode: 0 };
  } catch (e) { return err(e); }
}

export async function getRestartStatus(environment: string): Promise<CommandResult> {
  try {
    const { tenantUrl, token } = await bootstrap(environment);
    const res = await fetch(`${tenantUrl}/environment/startup`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-API-Version": RESTART_API_VERSION,
      },
    });
    const body = await readBody(res);
    if (!res.ok) return { stdout: "", stderr: `HTTP ${res.status}: ${body}`, exitCode: 1 };
    let status = "";
    try {
      const data = JSON.parse(body) as { restartStatus?: string };
      status = data.restartStatus ?? "";
    } catch {
      status = body.trim();
    }
    return { stdout: status, stderr: "", exitCode: 0 };
  } catch (e) { return err(e); }
}

// ── /environment/direct-configuration/session/* ──────────────────────────────

const DCC_BASE = "/environment/direct-configuration/session";

export async function getDirectControlState(environment: string): Promise<CommandResult> {
  try {
    const { tenantUrl, token } = await bootstrap(environment);
    const res = await fetch(`${tenantUrl}${DCC_BASE}/state`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await readBody(res);
    if (!res.ok) return { stdout: "", stderr: `HTTP ${res.status}: ${body}`, exitCode: 1 };
    return { stdout: body, stderr: "", exitCode: 0 };
  } catch (e) { return err(e); }
}

async function dccLifecycle(
  environment: string,
  op: "init" | "apply" | "abort",
): Promise<CommandResult> {
  try {
    const { tenantUrl, token } = await bootstrap(environment);
    const res = await fetch(`${tenantUrl}${DCC_BASE}/${op}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await readBody(res);
    if (!res.ok) return { stdout: "", stderr: `HTTP ${res.status}: ${body}`, exitCode: 1 };
    return { stdout: body || `direct-control ${op} OK\n`, stderr: "", exitCode: 0 };
  } catch (e) { return err(e); }
}

export const initDirectControl  = (environment: string) => dccLifecycle(environment, "init");
export const applyDirectControl = (environment: string) => dccLifecycle(environment, "apply");
export const abortDirectControl = (environment: string) => dccLifecycle(environment, "abort");
