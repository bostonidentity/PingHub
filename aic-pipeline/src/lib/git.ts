import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getHistoryGitRoot, buildTrailers, type OpMetadata } from "./op-history";

const REPO_ROOT = process.cwd();
const ENVIRONMENTS_DIR = path.join(REPO_ROOT, "environments");

/** Directory to run git commands in — the nested environments repo if initialized, else null. */
function getGitCwd(): string | null {
  return getHistoryGitRoot();
}

/** Path to an environment's directory relative to the configured git root. */
function envRelPath(environment: string): string {
  const cwd = getGitCwd() ?? REPO_ROOT;
  return path.relative(cwd, path.join(ENVIRONMENTS_DIR, environment));
}

// ── Scope mapping (mirrors the audit route) ──────────────────────────────────

const SCOPE_DIR: Record<string, string> = {
  "access-config":         "access-config",
  "audit":                 "audit",
  "connector-definitions": "sync/connectors",
  "connector-mappings":    "sync/mappings",
  "cookie-domains":        "cookie-domains",
  "cors":                  "cors",
  "csp":                   "csp",
  "custom-nodes":          "custom-nodes",
  "email-provider":        "email-provider",
  "email-templates":       "email-templates",
  "endpoints":             "endpoints",
  "idm-authentication":    "idm-authentication-config",
  "iga-workflows":         "iga/workflows",
  "internal-roles":        "internal-roles",
  "kba":                   "kba",
  "locales":               "locales",
  "managed-objects":       "managed-objects",
  "org-privileges":        "org-privileges",
  "raw":                   "raw",
  "remote-servers":        "sync/rcs",
  "schedules":             "schedules",
  "secrets":               "esvs/secrets",
  "service-objects":       "service-objects",
  "telemetry":             "telemetry",
  "terms-and-conditions":  "terms-conditions",
  "ui-config":             "ui",
  "variables":             "esvs/variables",
};

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

/**
 * Return the absolute directories that back a given scope inside a config dir.
 * Global scopes resolve to one directory; realm scopes expand to one per realm on disk.
 * Scopes with no mapping return an empty array.
 */
export function getScopePruneTargets(configDirAbs: string, scope: string): string[] {
  const targets: string[] = [];
  if (scope in SCOPE_DIR) {
    targets.push(path.join(configDirAbs, SCOPE_DIR[scope]));
  }
  if (scope in REALM_SCOPE_SUBDIR) {
    const realmsDir = path.join(configDirAbs, "realms");
    if (fs.existsSync(realmsDir)) {
      for (const entry of fs.readdirSync(realmsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        targets.push(path.join(realmsDir, entry.name, REALM_SCOPE_SUBDIR[scope]));
      }
    }
  }
  return targets;
}

/**
 * Delete the on-disk directories backing each given scope so a subsequent pull
 * acts as a mirror of remote state. Returns the absolute paths that were deleted
 * (existing directories only). Caller is expected to have committed any local
 * changes first so nothing is unrecoverable.
 */
export function pruneScopeDirs(configDirAbs: string, scopes: string[]): string[] {
  const deleted: string[] = [];
  for (const scope of scopes) {
    for (const target of getScopePruneTargets(configDirAbs, scope)) {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        deleted.push(target);
      }
    }
  }
  return deleted;
}

/** Reverse lookup: given a relative path segment inside a config dir, return the scope name. */
function dirToScope(relPath: string): string | null {
  // Check realm-based scopes first: realms/<realm>/<subdir>/...
  const realmMatch = relPath.match(/^realms\/[^/]+\/(.+)/);
  if (realmMatch) {
    const afterRealm = realmMatch[1];
    for (const [scope, subdir] of Object.entries(REALM_SCOPE_SUBDIR)) {
      if (afterRealm === subdir || afterRealm.startsWith(subdir + "/")) return scope;
    }
  }
  // Check global scopes
  for (const [scope, dir] of Object.entries(SCOPE_DIR)) {
    if (relPath === dir || relPath.startsWith(dir + "/")) return scope;
  }
  return null;
}

// ── Scope labels (matches CONFIG_SCOPES from fr-config-types) ────────────────

const SCOPE_LABELS: Record<string, string> = {
  "access-config":         "Access Config",
  "audit":                 "Audit",
  "authentication":        "Authentication",
  "authz-policies":        "Authorization Policies",
  "connector-definitions": "Connector Definitions",
  "connector-mappings":    "Connector Mappings",
  "cookie-domains":        "Cookie Domains",
  "cors":                  "CORS",
  "csp":                   "CSP",
  "custom-nodes":          "Custom Nodes",
  "email-provider":        "Email Provider",
  "email-templates":       "Email Templates",
  "endpoints":             "Custom Endpoints",
  "idm-authentication":    "IDM Authentication",
  "iga-workflows":         "IGA Workflows",
  "internal-roles":        "Internal Roles",
  "journeys":              "Journeys",
  "kba":                   "KBA",
  "locales":               "Locales",
  "managed-objects":       "Managed Objects",
  "oauth2-agents":         "OAuth2 Agents",
  "org-privileges":        "Org Privileges",
  "password-policy":       "Password Policy",
  "raw":                   "Raw Config",
  "remote-servers":        "Remote Servers",
  "saml":                  "SAML Entities",
  "schedules":             "Schedules",
  "scripts":               "Scripts",
  "secret-mappings":       "Secret Mappings",
  "secrets":               "Secrets",
  "service-objects":       "Service Objects",
  "services":              "Services",
  "telemetry":             "Telemetry",
  "terms-and-conditions":  "Terms & Conditions",
  "themes":                "Themes",
  "ui-config":             "UI Config",
  "variables":             "Variables (ESVs)",
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Item name extraction ─────────────────────────────────────────────────────

/**
 * Extract a human-readable item name from a file path relative to the scope directory.
 * For journeys: the first directory name (journey name).
 * For scripts: the first directory under scripts-content type dirs, or config filename.
 * For others: the filename without extension.
 */
function extractItemName(scope: string, pathInScope: string): string {
  const parts = pathInScope.split("/");

  if (scope === "journeys") {
    // realms/<realm>/journeys/<journeyName>/...
    return parts[0];
  }
  if (scope === "scripts") {
    // scripts-content/<type>/<scriptName>.js or scripts-config/<uuid>.json
    if (parts[0] === "scripts-content" && parts.length >= 3) {
      return parts[2].replace(/\.[^.]+$/, "");
    }
    if (parts[0] === "scripts-config" && parts.length >= 2) {
      return parts[1].replace(/\.[^.]+$/, "");
    }
  }
  // Default: filename without extension
  return parts[parts.length - 1].replace(/\.[^.]+$/, "");
}

// ── Change analysis ──────────────────────────────────────────────────────────

export interface ScopeChange {
  scope: string;
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Analyze uncommitted changes for an environment directory.
 * Returns per-scope breakdown with individual item names.
 */
export function analyzeChanges(environment: string, configDirRel: string): ScopeChange[] {
  const cwd = getGitCwd();
  if (!cwd) return [];
  const relPath = envRelPath(environment);
  const output = execSync(`git status --porcelain -- "${relPath}"`, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();

  if (!output) return [];

  // configPrefix is the path from repo root to the config dir, e.g. "environments/ide3/config/ide3"
  const configPrefix = path.join(relPath, configDirRel) + "/";

  const scopeMap = new Map<string, { added: Set<string>; modified: Set<string>; deleted: Set<string> }>();

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const status = line.substring(0, 2).trim();
    const filePath = line.substring(3).trim();

    // Only analyze files inside the config dir
    if (!filePath.startsWith(configPrefix)) continue;

    const relToConfig = filePath.substring(configPrefix.length);
    const scope = dirToScope(relToConfig);
    if (!scope) continue;

    // Get path within the scope directory for item name extraction
    let scopeDir: string;
    const realmMatch = relToConfig.match(/^realms\/[^/]+\//);
    if (realmMatch && scope in REALM_SCOPE_SUBDIR) {
      scopeDir = realmMatch[0] + REALM_SCOPE_SUBDIR[scope] + "/";
    } else if (scope in SCOPE_DIR) {
      scopeDir = SCOPE_DIR[scope] + "/";
    } else {
      continue;
    }

    const pathInScope = relToConfig.startsWith(scopeDir)
      ? relToConfig.substring(scopeDir.length)
      : relToConfig;

    const itemName = extractItemName(scope, pathInScope);

    if (!scopeMap.has(scope)) {
      scopeMap.set(scope, { added: new Set(), modified: new Set(), deleted: new Set() });
    }
    const entry = scopeMap.get(scope)!;

    if (status === "?" || status === "A") {
      entry.added.add(itemName);
    } else if (status === "D") {
      entry.deleted.add(itemName);
    } else {
      entry.modified.add(itemName);
    }
  }

  return Array.from(scopeMap.entries())
    .map(([scope, { added, modified, deleted }]) => ({
      scope,
      added: [...added].sort(),
      modified: [...modified].sort(),
      deleted: [...deleted].sort(),
    }))
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

// ── Commit message building ──────────────────────────────────────────────────

function buildSummaryLine(title: string, changes: ScopeChange[]): string {
  const totalFiles = changes.reduce(
    (sum, s) => sum + s.added.length + s.modified.length + s.deleted.length,
    0
  );
  const scopeNames = changes.map((s) => scopeLabel(s.scope)).join(", ");
  return `${title} — ${totalFiles} items across ${changes.length} scope${changes.length !== 1 ? "s" : ""} (${scopeNames})`;
}

export function buildCommitMessage(
  title: string,
  environment: string,
  configDirRel: string,
  metadata?: OpMetadata,
): string {
  const changes = analyzeChanges(environment, configDirRel);

  const trailerBlock = metadata ? buildTrailers(metadata) : null;
  const appendTrailers = (body: string) => (trailerBlock ? `${body}\n\n${trailerBlock}` : body);

  if (changes.length === 0) return appendTrailers(title);

  const summary = buildSummaryLine(title, changes);

  const scopeLines = changes.map((s) => {
    const parts: string[] = [];
    if (s.added.length) parts.push(`+${s.added.length}`);
    if (s.modified.length) parts.push(`~${s.modified.length}`);
    if (s.deleted.length) parts.push(`-${s.deleted.length}`);
    return `  ${scopeLabel(s.scope)}: ${parts.join(" ")}`;
  });

  return appendTrailers(`${summary}\n\n${scopeLines.join("\n")}`);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Check whether an environment directory has uncommitted changes (staged or unstaged, plus untracked). */
export function hasChanges(environment: string): boolean {
  const cwd = getGitCwd();
  if (!cwd) return false;
  const relPath = envRelPath(environment);
  const status = execSync(`git status --porcelain -- "${relPath}"`, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  return status.length > 0;
}

/**
 * Stage and commit all changes in an environment directory inside the nested environments repo.
 * Returns the short commit hash, or null if the repo isn't initialized or nothing to commit.
 */
export function autoCommit(
  environment: string,
  title: string,
  configDirRel: string,
  metadata?: OpMetadata,
): string | null {
  const cwd = getGitCwd();
  if (!cwd) return null;
  if (!hasChanges(environment)) return null;

  const message = buildCommitMessage(title, environment, configDirRel, metadata);
  const relPath = envRelPath(environment);
  execSync(`git add -- "${relPath}"`, { cwd, maxBuffer: 10 * 1024 * 1024 });
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd, maxBuffer: 10 * 1024 * 1024 });

  const hash = execSync("git rev-parse --short HEAD", {
    cwd,
    encoding: "utf-8",
  }).trim();
  return hash;
}
