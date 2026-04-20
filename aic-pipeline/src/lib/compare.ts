import type { CompareReport, FileDiff } from "@/lib/diff-types";

export interface DiffSummary {
  scope: string;
  added: number;
  modified: number;
  removed: number;
}

const SCOPE_LABELS: Record<string, string> = {
  "access-config": "Access Config", "audit": "Audit", "authz-policies": "Authorization Policies",
  "connector-definitions": "Connector Definitions", "connector-mappings": "Connector Mappings",
  "cookie-domains": "Cookie Domains", "cors": "CORS", "csp": "CSP", "custom-nodes": "Custom Nodes",
  "email-provider": "Email Provider", "email-templates": "Email Templates", "endpoints": "Custom Endpoints",
  "idm-authentication": "IDM Authentication", "iga-workflows": "IGA Workflows",
  "internal-roles": "Internal Roles", "journeys": "Journeys", "kba": "KBA", "locales": "Locales",
  "managed-objects": "Managed Objects", "oauth2-agents": "OAuth2 Agents", "org-privileges": "Org Privileges",
  "password-policy": "Password Policy", "raw": "Raw Config", "remote-servers": "Remote Servers",
  "saml": "SAML Entities", "schedules": "Schedules", "scripts": "Scripts",
  "secret-mappings": "Secret Mappings", "secrets": "Secrets", "service-objects": "Service Objects",
  "services": "Services", "telemetry": "Telemetry", "terms-and-conditions": "Terms & Conditions",
  "themes": "Themes", "ui-config": "UI Config", "variables": "Variables (ESVs)",
};

/** Human-readable label for a scope key (client-safe). */
export function formatScopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function scopeOf(file: FileDiff): string | null {
  if (file.scope) return file.scope;
  if (!file.relativePath) return null;
  const parts = file.relativePath.split("/");
  // Realm-based: realms/<realm>/<scope>/...
  if (parts[0] === "realms" && parts.length >= 3) return parts[2];
  // Global: <scope>/...
  return parts[0];
}

/** Scopes where each "item" is a directory containing multiple files. */
const DIR_ITEM_SCOPES = new Set([
  "endpoints", "schedules", "custom-nodes", "journeys",
  "managed-objects", "email-templates", "themes", "iga-workflows",
]);

/** Extract a logical item key from a file path for dir-based scopes. */
function itemKeyForFile(file: FileDiff, scope: string): string {
  if (!DIR_ITEM_SCOPES.has(scope)) return file.relativePath;
  const parts = file.relativePath.split("/");
  // Realm-based: realms/<realm>/<scope>/<item>/...
  if (parts[0] === "realms" && parts.length >= 4) return `${parts[1]}/${parts[3]}`;
  // Global: <scope>/<item>/...
  // custom-nodes has an extra nodes/ level: custom-nodes/nodes/<item>/...
  let idx = 1;
  if (scope === "custom-nodes" && parts[idx] === "nodes") idx++;
  return parts[idx] ?? file.relativePath;
}

/**
 * Collapses a CompareReport's file-level diffs into a per-scope summary.
 * For directory-based scopes (endpoints, journeys, etc.), counts unique
 * logical items rather than raw files. Scopes with only unchanged files
 * are dropped.
 */
export function summarizeReport(report: CompareReport): DiffSummary[] {
  // Group files by scope, then deduplicate by item key
  const byScope = new Map<string, Map<string, FileDiff["status"]>>();
  const priority: Record<string, number> = { added: 3, removed: 2, modified: 1, unchanged: 0 };

  for (const file of report.files) {
    const scope = scopeOf(file);
    if (!scope) continue;
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    const items = byScope.get(scope)!;
    const key = itemKeyForFile(file, scope);
    const prev = items.get(key);
    if (!prev || (priority[file.status] ?? 0) > (priority[prev] ?? 0)) {
      items.set(key, file.status);
    }
  }

  const result: DiffSummary[] = [];
  for (const [scope, items] of byScope) {
    let added = 0, modified = 0, removed = 0;
    for (const status of items.values()) {
      if (status === "added") added++;
      else if (status === "modified") modified++;
      else if (status === "removed") removed++;
    }
    if (added > 0 || modified > 0 || removed > 0) {
      result.push({ scope, added, modified, removed });
    }
  }
  return result;
}
