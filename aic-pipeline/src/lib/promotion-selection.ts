import fs from "fs";
import path from "path";
import { getRealmRoots } from "@/lib/realm-paths";

export const SCOPE_DIR: Record<string, string> = {
  "access-config": "access-config", "audit": "audit",
  "connector-definitions": "sync/connectors", "connector-mappings": "sync/mappings",
  "cookie-domains": "cookie-domains", "cors": "cors", "csp": "csp",
  "custom-nodes": "custom-nodes", "email-provider": "email-provider",
  "email-templates": "email-templates", "endpoints": "endpoints",
  "idm-authentication": "idm-authentication-config", "iga-workflows": "iga/workflows",
  "internal-roles": "internal-roles", "kba": "kba", "locales": "locales",
  "managed-objects": "managed-objects", "org-privileges": "org-privileges",
  "raw": "raw", "remote-servers": "sync/rcs", "schedules": "schedules",
  "secrets": "esvs/secrets", "service-objects": "service-objects",
  "telemetry": "telemetry", "terms-and-conditions": "terms-conditions",
  "ui-config": "ui", "variables": "esvs/variables",
};

export const REALM_SCOPE_SUBDIR: Record<string, string> = {
  "authz-policies": "authorization", "journeys": "journeys",
  "oauth2-agents": "realm-config/agents", "password-policy": "password-policy",
  "saml": "realm-config/saml", "scripts": "scripts",
  "secret-mappings": "secret-mappings", "services": "services", "themes": "themes",
};

export function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Rel path under the temp staging dir for a source scope dir. The vendored
 * fr-config-manager push modules expect `realms/<realm>/<scope>/...`, so when
 * the source was pulled in the vendored-pull layout (`<realm>/<scope>/...`
 * without the `realms/` prefix), this prepends `realms/` for realm-scoped
 * scopes. Global scopes are left as-is.
 */
export function stagingRelPath(configDir: string, srcDir: string, scope: string): string {
  const rel = path.relative(configDir, srcDir).split(path.sep).join("/");
  if ((scope in REALM_SCOPE_SUBDIR) && !rel.startsWith("realms/")) {
    return `realms/${rel}`;
  }
  return rel;
}

/** Resolve scope to absolute directory paths within a config dir. */
export function resolveScopeDirs(configDir: string, scope: string): string[] {
  if (scope in REALM_SCOPE_SUBDIR) {
    const subdir = REALM_SCOPE_SUBDIR[scope];
    return getRealmRoots(configDir, subdir).map((root) => path.join(root, subdir));
  }
  const dirName = SCOPE_DIR[scope] ?? scope;
  const d = path.join(configDir, dirName);
  return fs.existsSync(d) ? [d] : [];
}

/**
 * Build a name -> _id map by scanning JSON files in the given directories.
 * Works for scripts (scripts-config/*.json), journeys (journeyName/journeyName.json),
 * endpoints (endpointName/endpointName.js -> same dir has .json), and generic JSON.
 */
export function buildNameToIdMap(dirs: string[], scope: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of dirs) {
    if (scope === "scripts") {
      // Scripts: scripts-config/{uuid}.json -> { name, _id }
      const configDir = path.join(dir, "scripts-config");
      if (!fs.existsSync(configDir)) continue;
      for (const f of fs.readdirSync(configDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const json = JSON.parse(fs.readFileSync(path.join(configDir, f), "utf-8")) as { name?: string; _id?: string };
          if (json.name && json._id) map.set(json.name, json._id);
        } catch { /* skip */ }
      }
    } else if (scope === "journeys") {
      // Journeys use directory names, so no _id remapping is needed.
    } else {
      const scanDir = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const inner = path.join(d, entry.name, `${entry.name}.json`);
            if (fs.existsSync(inner)) {
              try {
                const json = JSON.parse(fs.readFileSync(inner, "utf-8")) as { _id?: string };
                if (json._id) map.set(entry.name, json._id);
              } catch { /* skip */ }
            }
          } else if (entry.name.endsWith(".json")) {
            try {
              const json = JSON.parse(fs.readFileSync(path.join(d, entry.name), "utf-8")) as { _id?: string; name?: string };
              const name = json.name ?? path.basename(entry.name, ".json");
              if (json._id) map.set(name, json._id);
            } catch { /* skip */ }
          }
        }
      };
      scanDir(dir);
    }
  }
  return map;
}

/**
 * Remap _id fields in the temp config directory to match target IDs.
 * Only processes JSON files that have an _id field.
 */
export function remapIds(
  tempDirs: string[],
  scope: string,
  sourceNameToId: Map<string, string>,
  targetNameToId: Map<string, string>,
  logs: string[],
): void {
  void sourceNameToId;

  if (scope === "scripts") {
    for (const dir of tempDirs) {
      const configDir = path.join(dir, "scripts-config");
      if (!fs.existsSync(configDir)) continue;
      for (const f of fs.readdirSync(configDir)) {
        if (!f.endsWith(".json")) continue;
        const fp = path.join(configDir, f);
        try {
          const json = JSON.parse(fs.readFileSync(fp, "utf-8")) as { _id?: string; name?: string };
          if (!json.name || !json._id) continue;
          const targetId = targetNameToId.get(json.name);
          if (targetId && targetId !== json._id) {
            const oldId = json._id;
            json._id = targetId;
            fs.writeFileSync(fp, JSON.stringify(json, null, 2));
            const newFp = path.join(configDir, `${targetId}.json`);
            if (fp !== newFp) fs.renameSync(fp, newFp);
            logs.push(`Remapped script "${json.name}": ${oldId} -> ${targetId}`);
          } else if (!targetId) {
            logs.push(`Script "${json.name}" not found on target - will be created with ID ${json._id}`);
          }
        } catch { /* skip */ }
      }
    }
  } else if (scope === "journeys") {
    logs.push("Journeys matched by directory name - no ID remapping needed");
  } else {
    for (const dir of tempDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const inner = path.join(dir, entry.name, `${entry.name}.json`);
          if (!fs.existsSync(inner)) continue;
          try {
            const json = JSON.parse(fs.readFileSync(inner, "utf-8")) as { _id?: string };
            if (!json._id) continue;
            const targetId = targetNameToId.get(entry.name);
            if (targetId && targetId !== json._id) {
              const oldId = json._id;
              json._id = targetId;
              fs.writeFileSync(inner, JSON.stringify(json, null, 2));
              logs.push(`Remapped "${entry.name}": ${oldId} -> ${targetId}`);
            } else if (!targetId) {
              logs.push(`"${entry.name}" not found on target - will be created`);
            }
          } catch { /* skip */ }
        } else if (entry.name.endsWith(".json")) {
          const fp = path.join(dir, entry.name);
          try {
            const json = JSON.parse(fs.readFileSync(fp, "utf-8")) as { _id?: string; name?: string };
            if (!json._id) continue;
            const name = json.name ?? path.basename(entry.name, ".json");
            const targetId = targetNameToId.get(name);
            if (targetId && targetId !== json._id) {
              const oldId = json._id;
              json._id = targetId;
              fs.writeFileSync(fp, JSON.stringify(json, null, 2));
              logs.push(`Remapped "${name}": ${oldId} -> ${targetId}`);
            } else if (!targetId) {
              logs.push(`"${name}" not found on target - will be created`);
            }
          } catch { /* skip */ }
        }
      }
    }
  }
}
