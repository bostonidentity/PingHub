import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { FILENAME_FILTER_SCOPES, NAME_FLAG_SCOPES } from "@/lib/fr-config-types";
import { getRealmRoots } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

// ── Scope → directory mapping ──────────────────────────────────────────────────

const SCOPE_DIR: Record<string, string> = {
  "access-config":        "access-config",
  "audit":                "audit",
  "am-agents":            "agents",
  "connector-definitions":"sync/connectors",
  "connector-mappings":   "sync/mappings",
  "cookie-domains":       "cookie-domains",
  "cors":                 "cors",
  "csp":                  "csp",
  "custom-nodes":         "custom-nodes",
  "email-provider":       "email-provider",
  "email-templates":      "email-templates",
  "endpoints":            "endpoints",
  "idm-authentication":   "idm-authentication-config",
  "iga-applications":     "iga/applications",
  "iga-entitlements":     "iga/entitlements",
  "iga-forms":            "iga/forms",
  "iga-assignments":      "iga/assignments",
  "iga-notifications":    "iga/notifications",
  "iga-workflows":        "iga/workflows",
  "internal-roles":       "internal-roles",
  "kba":                  "kba",
  "locales":              "locales",
  "managed-objects":      "managed-objects",
  "oidc-providers":       "idp",
  "org-privileges":       "org-privileges",
  "raw":                  "raw",
  "remote-servers":       "sync/rcs",
  "schedules":            "schedules",
  "secrets":              "esvs/secrets",
  "service-objects":      "service-objects",
  "telemetry":            "telemetry",
  "terms-and-conditions": "terms-conditions",
  "ui-config":            "ui",
  "variables":            "esvs/variables",
};

// Realm-based scopes: CONFIG_DIR/realms/<realm>/<subdir>
const REALM_SCOPE_SUBDIR: Record<string, string> = {
  "authz-policies":  "authorization",
  "journeys":        "journeys",
  "oauth2-agents":   "realm-config/agents",
  "password-policy": "password-policy",
  "saml":            "realm-config/saml",
  "scripts":         "scripts",
  "secret-mappings": "secret-mappings",
  "services":        "services",
  "themes":          "themes",
};

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AuditItem {
  /** Identifier passed to the CLI (filename or directory name) */
  id: string;
  /** Human-readable display name */
  label: string;
  /** Decoded value, populated for ESV variables */
  value?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Realm-scoped <subdir> directories that exist on disk, across both layouts. */
function getRealmDirs(configDir: string, subdir: string): string[] {
  return getRealmRoots(configDir, subdir).map((root) => path.join(root, subdir));
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}

function listEntries(dir: string, filter: "files" | "dirs"): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => filter === "dirs" ? e.isDirectory() : e.isFile())
    .map((e) => e.name)
    .sort();
}

/** Read the `name` field from a JSON file, falling back to the filename stem. */
function readJsonName(filePath: string, fallback: string): string {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return (typeof json.name === "string" && json.name) ? json.name : fallback;
  } catch {
    return fallback;
  }
}

// ── Item builders ──────────────────────────────────────────────────────────────

/** Scripts: id = UUID filename, label = name from JSON */
function scriptItems(scriptsDirs: string[]): AuditItem[] {
  const seen = new Set<string>();
  const items: AuditItem[] = [];
  for (const dir of scriptsDirs) {
    const configDir = path.join(dir, "scripts-config");
    const target = fs.existsSync(configDir) ? configDir : dir;
    for (const file of listEntries(target, "files")) {
      if (seen.has(file)) continue;
      seen.add(file);
      const label = readJsonName(path.join(target, file), path.basename(file, ".json"));
      items.push({ id: file, label });
    }
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

/** Journeys: id = journey directory name, label = same (dirs are already named) */
function journeyItems(journeyDirs: string[]): AuditItem[] {
  const seen = new Set<string>();
  const items: AuditItem[] = [];
  for (const dir of journeyDirs) {
    for (const name of listEntries(dir, "dirs")) {
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({ id: name, label: name });
    }
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

/** Generic: id = label = filename or dirname */
function genericItems(dir: string, filter: "files" | "dirs"): AuditItem[] {
  return listEntries(dir, filter).map((name) => ({ id: name, label: name }));
}

/** Read the decoded ESV variable value from a file (Frodo or fr-config-manager format). */
function readVariableValue(filePath: string): string | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    // Frodo format: { variable: { "<id>": { value: "..." } } }
    if (json.variable && typeof json.variable === "object") {
      const entry = Object.values(json.variable)[0] as Record<string, unknown>;
      if (typeof entry?.value === "string") return entry.value;
    }
    // fr-config-manager format: { valueBase64: "..." } — skip ${...} placeholders
    if (typeof json.valueBase64 === "string" && !json.valueBase64.startsWith("${")) {
      return json.valueBase64;
    }
  } catch { /* ignore */ }
  return undefined;
}

/** Variables: id = label = filename, value = decoded ESV value if available */
function variableItems(dir: string): AuditItem[] {
  return listEntries(dir, "files").map((name) => ({
    id: name,
    label: name,
    value: readVariableValue(path.join(dir, name)),
  }));
}

// ── Scope audit ────────────────────────────────────────────────────────────────

function auditScope(configDir: string, scope: string) {
  const isFilenameFilter = (FILENAME_FILTER_SCOPES as readonly string[]).includes(scope);
  const isNameFlag = (NAME_FLAG_SCOPES as readonly string[]).includes(scope);
  const selectable = isFilenameFilter || isNameFlag;

  // Realm-based scope
  if (scope in REALM_SCOPE_SUBDIR) {
    const subdir = REALM_SCOPE_SUBDIR[scope];
    const realmDirs = getRealmDirs(configDir, subdir);

    const fileCount = realmDirs.reduce((sum, d) => sum + countFiles(d), 0);
    const exists = realmDirs.length > 0;

    // Realm-based scopes that store items as directories
    const REALM_DIR_BASED_SCOPES = new Set(["themes"]);

    let items: AuditItem[];
    if (scope === "scripts") {
      items = scriptItems(realmDirs);
    } else if (isNameFlag) {
      // Journey dirs (and other NAME_FLAG realm scopes): list individual item dirs
      items = journeyItems(realmDirs);
    } else if (REALM_DIR_BASED_SCOPES.has(scope)) {
      items = realmDirs.flatMap((d) => genericItems(d, "dirs"));
    } else {
      items = realmDirs.flatMap((d) => genericItems(d, "files"));
    }

    return { scope, fileCount, exists, items, selectable };
  }

  // Direct scope
  const dirName = SCOPE_DIR[scope] ?? scope;
  const scopeDir = path.join(configDir, dirName);
  const exists = fs.existsSync(scopeDir);
  const fileCount = countFiles(scopeDir);

  // Scopes that store items as directories (not files) at the top level.
  // connector-mappings: each mapping lives in sync/mappings/<mapping-name>/
  // email-templates:    each template is a dir with per-locale HTML files
  const DIR_BASED_SCOPES = new Set(["email-templates", "connector-mappings"]);

  let items: AuditItem[];
  if (isNameFlag || isFilenameFilter || DIR_BASED_SCOPES.has(scope)) {
    // custom-nodes stores nodes under a nodes/ subdirectory: custom-nodes/nodes/<name>/
    const nodesSubDir = path.join(scopeDir, "nodes");
    const itemsDir = (scope === "custom-nodes" && fs.existsSync(nodesSubDir)) ? nodesSubDir : scopeDir;
    items = genericItems(itemsDir, "dirs");
  } else if (scope === "variables") {
    items = variableItems(scopeDir);
  } else {
    items = genericItems(scopeDir, "files");
  }

  return { scope, fileCount, exists, items, selectable };
}

// ── Route ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const environment = searchParams.get("environment");
  const scopesParam = searchParams.get("scopes");

  if (!environment) {
    return NextResponse.json({ error: "Missing environment" }, { status: 400 });
  }

  const configDir = getConfigDir(environment);
  if (!configDir) {
    return NextResponse.json({ error: "Config dir not found for environment" }, { status: 404 });
  }

  const scopes = scopesParam ? scopesParam.split(",").filter(Boolean) : [];
  const audit = scopes.map((scope) => auditScope(configDir, scope));

  return NextResponse.json(audit);
}
