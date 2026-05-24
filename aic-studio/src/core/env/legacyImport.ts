import type { Database } from "better-sqlite3";
import { getEnvironmentByName } from "../db/environments";
import type { BundleEnvEntry } from "./legacyBundle";
import type { NewEnvironment, EnvironmentColor } from "./types";

const COLOR_MAP: Record<string, EnvironmentColor> = {
  blue: "blue",
  green: "green",
  yellow: "yellow",
  red: "red",
  slate: "slate"
};

const NAME_INVALID = /[^a-z0-9\-_]/g;

function normalizeName(raw: string): string {
  const lower = raw.toLowerCase();
  const sanitized = lower.replace(NAME_INVALID, "-");
  return /^[a-z0-9]/.test(sanitized) ? sanitized : `e-${sanitized}`;
}

function mapColor(c: string | undefined): EnvironmentColor {
  if (!c) return "slate";
  return COLOR_MAP[c.toLowerCase()] ?? "slate";
}

export function mapBundleEntryToEnvironment(
  entry: BundleEnvEntry,
  vars: Record<string, string>
): { env?: NewEnvironment; errors: string[] } {
  const errors: string[] = [];
  const tenantUrl = (vars.TENANT_BASE_URL ?? "").trim();
  const clientId = (vars.SERVICE_ACCOUNT_ID ?? vars.FRODO_SA_ID ?? "").trim();
  const username = (vars.FRODO_USERNAME ?? "").trim() || clientId;

  if (!tenantUrl) errors.push("missing TENANT_BASE_URL");
  if (!clientId) errors.push("missing SERVICE_ACCOUNT_ID");
  if (errors.length) return { errors };

  return {
    env: {
      name: normalizeName(entry.meta.name),
      label: entry.meta.label || entry.meta.name,
      tenantUrl,
      username,
      clientId,
      color: mapColor(entry.meta.color)
    },
    errors: []
  };
}

const REDACTED = "<REDACTED>";

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v !== REDACTED;
}

export interface LegacyLogApiFile {
  apiKey?: string;
  apiSecret?: string;
}

export function mapBundleEntryToSecrets(
  entry: BundleEnvEntry,
  vars: Record<string, string>
): Partial<Record<"client-secret" | "password" | "log-api-key" | "log-api-secret", string>> {
  const out: Partial<Record<"client-secret" | "password" | "log-api-key" | "log-api-secret", string>> = {};
  if (nonEmpty(vars.SERVICE_ACCOUNT_CLIENT_SECRET)) out["client-secret"] = vars.SERVICE_ACCOUNT_CLIENT_SECRET;
  if (nonEmpty(vars.FRODO_PASSWORD)) out["password"] = vars.FRODO_PASSWORD;
  if (nonEmpty(vars.LOG_API_KEY)) {
    out["log-api-key"] = vars.LOG_API_KEY;
  } else {
    const file = entry.files?.["log-api.json"] as LegacyLogApiFile | undefined;
    if (file && nonEmpty(file.apiKey)) out["log-api-key"] = file.apiKey;
  }
  if (nonEmpty(vars.LOG_API_SECRET)) {
    out["log-api-secret"] = vars.LOG_API_SECRET;
  } else {
    const file = entry.files?.["log-api.json"] as LegacyLogApiFile | undefined;
    if (file && nonEmpty(file.apiSecret)) out["log-api-secret"] = file.apiSecret;
  }
  return out;
}

export interface ConflictRow {
  bundleName: string;
  normalizedName: string;
  exists: boolean;
}

export type ImportPlan = ConflictRow[];

export function planConflicts(db: Database, entries: BundleEnvEntry[]): ImportPlan {
  return entries.map((e) => {
    const normalized = normalizeName(e.meta.name);
    return {
      bundleName: e.meta.name,
      normalizedName: normalized,
      exists: !!getEnvironmentByName(db, normalized)
    };
  });
}

export const _testing = { normalizeName, mapColor };
