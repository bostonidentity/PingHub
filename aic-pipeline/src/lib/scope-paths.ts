/**
 * Scope ↔ on-disk path mappings and a helper to derive the scope + item
 * identifier from a config-relative file path.
 *
 * Kept in `src/lib` so it can be imported from server routes (audit/item
 * APIs) and client components (AnalyzePanel, ConfigsViewer) without
 * duplicating the maps.
 */

export const SCOPE_DIR: Record<string, string> = {
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

export const REALM_SCOPE_SUBDIR: Record<string, string> = {
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

/** Strip an optional leading "realms/<realm>/" or "<realm>/" to get the scope-relative path. */
function stripRealmPrefix(relPath: string): string {
  const parts = relPath.split("/");
  if (parts.length < 2) return relPath;
  if (parts[0] === "realms" && parts.length >= 3) return parts.slice(2).join("/");
  // A single realm-like prefix (alpha/bravo/<custom>) is ambiguous: treat as
  // a realm prefix only when the NEXT segment matches a known realm subdir.
  const next = parts[1];
  if (Object.values(REALM_SCOPE_SUBDIR).some((sd) => sd === next || sd.startsWith(`${next}/`))) {
    return parts.slice(1).join("/");
  }
  return relPath;
}

/**
 * Parse a config-relative path into `{ scope, item }`.
 * Returns null when the path doesn't match any known scope layout.
 *
 * Examples:
 *   "alpha/scripts/scripts-config/abc.json"          → { scope: "scripts",          item: "abc.json" }
 *   "alpha/scripts/scripts-content/OIDC/MyScript.js" → { scope: "scripts",          item: "MyScript.js" }
 *   "alpha/journeys/Login/nodes/xyz.json"            → { scope: "journeys",         item: "Login" }
 *   "managed-objects/alpha_user/schema.json"         → { scope: "managed-objects",  item: "alpha_user" }
 *   "endpoints/myep/myep.js"                         → { scope: "endpoints",        item: "myep" }
 *   "esvs/variables/esv-foo.variable.json"           → { scope: "variables",        item: "esv-foo.variable.json" }
 */
export function pathToScopeItem(relPath: string): { scope: string; item: string } | null {
  if (!relPath) return null;
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");

  // Realm-scoped paths: "[realms/]<realm>/<subdir>/<item>/..."
  const afterRealm = stripRealmPrefix(norm);
  for (const [scope, subdir] of Object.entries(REALM_SCOPE_SUBDIR)) {
    const prefix = `${subdir}/`;
    if (afterRealm.startsWith(prefix)) {
      const rest = afterRealm.slice(prefix.length);
      // scripts-config files are flat UUIDs; scripts-content is ctx/name.ext
      // Both live under the "scripts" subdir already — grab the next segment.
      const firstSeg = rest.split("/")[0];
      // For scripts-content, the interesting item is the filename, not ctx.
      // Detect that by checking if the subdir is "scripts" and the rest begins
      // with "scripts-content/".
      if (scope === "scripts") {
        if (rest.startsWith("scripts-content/")) {
          const tail = rest.slice("scripts-content/".length).split("/");
          return { scope, item: tail[tail.length - 1] ?? firstSeg };
        }
        if (rest.startsWith("scripts-config/")) {
          const tail = rest.slice("scripts-config/".length).split("/");
          return { scope, item: tail[0] ?? firstSeg };
        }
      }
      return { scope, item: firstSeg };
    }
  }

  // Direct-scope paths, longest prefix first so "iga/workflows" beats "iga".
  const entries = Object.entries(SCOPE_DIR).sort((a, b) => b[1].length - a[1].length);
  for (const [scope, dir] of entries) {
    const prefix = `${dir}/`;
    if (norm === dir) return { scope, item: "" };
    if (norm.startsWith(prefix)) {
      const rest = norm.slice(prefix.length);
      const firstSeg = rest.split("/")[0];
      return { scope, item: firstSeg };
    }
  }

  return null;
}
