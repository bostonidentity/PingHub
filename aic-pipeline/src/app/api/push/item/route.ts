import { NextRequest, NextResponse } from "next/server";
import { getConfigDir } from "@/lib/fr-config";
import { findRealmContaining } from "@/lib/realm-paths";
import fs from "fs";
import path from "path";

export interface ViewableFile {
  name: string;
  content: string;
  language: "json" | "javascript" | "groovy" | "text";
  /** Path on disk, relative to the environment's config dir. Needed for git info lookups. */
  relPath?: string;
}

// ── Directory mapping (mirrors audit route) ────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function readFile(filePath: string, configDir?: string): ViewableFile | null {
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const language: ViewableFile["language"] =
    ext === ".json" ? "json" :
    ext === ".js"   ? "javascript" :
    ext === ".groovy" ? "groovy" : "text";
  const relPath = configDir ? path.relative(configDir, filePath) : undefined;
  return { name: path.basename(filePath), content: fs.readFileSync(filePath, "utf-8"), language, relPath };
}

function readDir(dir: string, configDir?: string): ViewableFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFile(path.join(dir, e.name), configDir))
    .filter((f): f is ViewableFile => f !== null);
}

// ── Item resolution ────────────────────────────────────────────────────────────

function resolveScriptFiles(configDir: string, itemId: string): ViewableFile[] {
  const realmRoot = findRealmContaining(configDir, path.join("scripts", "scripts-config", itemId));
  if (!realmRoot) return [];

  const configPath = path.join(realmRoot, "scripts", "scripts-config", itemId);
  const files: ViewableFile[] = [];

  // Try to find the content file (.js / .groovy)
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const { name, context, language } = config;
    if (name && context) {
      const ext = language === "GROOVY" ? ".groovy" : ".js";
      const contentPath = path.join(realmRoot, "scripts", "scripts-content", context, `${name}${ext}`);
      const contentFile = readFile(contentPath, configDir);
      if (contentFile) files.push(contentFile);
    }
  } catch { /* ignore parse errors */ }

  const configFile = readFile(configPath, configDir);
  if (configFile) files.push(configFile);
  return files;
}

function resolveWorkflowFiles(configDir: string, itemId: string): ViewableFile[] {
  const workflowDir = path.join(configDir, "iga", "workflows", itemId);
  if (!fs.existsSync(workflowDir)) return [];
  const files: ViewableFile[] = [];
  const topFile = readFile(path.join(workflowDir, `${itemId}.json`), configDir);
  if (topFile) files.push(topFile);
  const stepsDir = path.join(workflowDir, "steps");
  if (fs.existsSync(stepsDir)) {
    for (const stepDir of fs.readdirSync(stepsDir, { withFileTypes: true })) {
      if (!stepDir.isDirectory()) continue;
      const stepDirPath = path.join(stepsDir, stepDir.name);
      for (const stepFile of fs.readdirSync(stepDirPath, { withFileTypes: true })) {
        if (!stepFile.isFile()) continue;
        if (!stepFile.name.endsWith(".json") && !stepFile.name.endsWith(".js")) continue;
        const f = readFile(path.join(stepDirPath, stepFile.name), configDir);
        if (f) files.push(f);
      }
    }
  }
  return files;
}

function resolveJourneyFiles(configDir: string, itemId: string): ViewableFile[] {
  const realmRoot = findRealmContaining(configDir, path.join("journeys", itemId));
  if (!realmRoot) return [];
  return readDir(path.join(realmRoot, "journeys", itemId), configDir);
}

function resolveItemFiles(configDir: string, scope: string, itemId: string): ViewableFile[] {
  if (scope === "scripts")       return resolveScriptFiles(configDir, itemId);
  if (scope === "journeys")      return resolveJourneyFiles(configDir, itemId);
  if (scope === "iga-workflows") return resolveWorkflowFiles(configDir, itemId);

  if (scope in REALM_SCOPE_SUBDIR) {
    const subdir = REALM_SCOPE_SUBDIR[scope];
    const realmRoot = findRealmContaining(configDir, path.join(subdir, itemId));
    if (!realmRoot) return [];
    const itemPath = path.join(realmRoot, subdir, itemId);
    if (fs.statSync(itemPath).isDirectory()) return readDir(itemPath, configDir);
    const itemFile = readFile(itemPath, configDir);
    return itemFile ? [itemFile] : [];
  }

  const dirName = SCOPE_DIR[scope] ?? scope;
  const scopeDir = path.join(configDir, dirName);

  const itemDir = path.join(scopeDir, itemId);
  if (fs.existsSync(itemDir) && fs.statSync(itemDir).isDirectory()) {
    return readDir(itemDir, configDir);
  }

  const file = readFile(path.join(scopeDir, itemId), configDir);
  return file ? [file] : [];
}

// ── Route ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const environment = searchParams.get("environment");
  const scope = searchParams.get("scope");
  const item = searchParams.get("item");

  if (!environment || !scope || !item) {
    return NextResponse.json({ error: "Missing environment, scope, or item" }, { status: 400 });
  }

  const configDir = getConfigDir(environment);
  if (!configDir) {
    return NextResponse.json({ error: "Config dir not found" }, { status: 404 });
  }

  const files = resolveItemFiles(configDir, scope, item);
  if (files.length === 0) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  return NextResponse.json({ files });
}
