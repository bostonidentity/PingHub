// Typed re-exports for the vendored fr-config-manager code.
// Import from this file only — never from the underlying .js files — so we
// can port the internals to TS incrementally without breaking callers.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const managed = require("./pull/managed.js") as {
  exportManagedObjects: (
    exportDir: string,
    tenantUrl: string,
    name: string | undefined,
    pullCustomRelationships: boolean,
    token: string,
    log?: (line: string) => void,
  ) => Promise<void>;
};

/**
 * Pull managed-objects from `tenantUrl` into `exportDir/managed-objects/...`.
 * Honors the `name` filter (fixed version — upstream drops anything after the
 * first non-match).
 */
export async function pullManagedObjects(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  pullCustomRelationships?: boolean;
  log?: (line: string) => void;
}): Promise<void> {
  await managed.exportManagedObjects(
    opts.exportDir,
    opts.tenantUrl,
    opts.name,
    opts.pullCustomRelationships ?? false,
    opts.token,
    opts.log,
  );
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pushMod = require("./push/update-managed-objects.js") as {
  updateManagedObjects: (opts: {
    configDir: string;
    tenantUrl: string;
    token: string;
    name?: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

/**
 * Push managed-objects from `configDir/managed-objects/**` to `tenantUrl`.
 *
 * When `name` is passed, only that object is sent; the function GETs the
 * target's current full config, splices in the one object, and PUTs back —
 * so sibling objects aren't accidentally reset. When `name` is omitted,
 * every subdir under `configDir/managed-objects/` is pushed as a full
 * replace (matches fr-config-push's default behavior).
 */
export async function pushManagedObjects(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await pushMod.updateManagedObjects(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scriptsPull = require("./pull/scripts.js") as {
  exportScripts: (opts: {
    exportDir: string;
    tenantUrl: string;
    token: string;
    realms?: string[];
    prefixes?: string[];
    name?: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

/**
 * Pull AM scripts from all realms (filtered by prefixes / name) into
 * `exportDir/<realm>/scripts/{scripts-config,scripts-content}/`.
 */
export async function pullScripts(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  prefixes?: string[];
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await scriptsPull.exportScripts(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scriptsPush = require("./push/update-scripts.js") as {
  updateScripts: (opts: {
    configDir: string;
    tenantUrl: string;
    token: string;
    realms?: string[];
    name?: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

/**
 * Push AM scripts from `configDir/realms/<realm>/scripts/scripts-config/*.json`.
 * When `name` is passed, only that script is pushed; `realms` must have exactly
 * one entry in that case.
 */
export async function pushScripts(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await scriptsPush.updateScripts(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const journeysPull = require("./pull/journeys.js") as {
  exportJourneys: (opts: {
    exportDir: string;
    tenantUrl: string;
    token: string;
    realms?: string[];
    name?: string;
    pullDependencies?: boolean;
    clean?: boolean;
    log?: (line: string) => void;
  }) => Promise<void>;
};

/**
 * Pull AM authentication trees (journeys) from `tenantUrl` into
 * `exportDir/<realm>/journeys/<id>/{<id>.json, nodes/}`. With
 * `pullDependencies: true`, referenced scripts and (when `name` is set)
 * inner journeys are pulled too.
 */
export async function pullJourneys(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  name?: string;
  pullDependencies?: boolean;
  clean?: boolean;
  log?: (line: string) => void;
}): Promise<void> {
  await journeysPull.exportJourneys(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const journeysPush = require("./push/update-auth-trees.js") as {
  updateAuthTrees: (opts: {
    configDir: string;
    tenantUrl: string;
    token: string;
    realms?: string[];
    name?: string;
    pushInnerJourneys?: boolean;
    pushScripts?: boolean;
    log?: (line: string) => void;
  }) => Promise<void>;
};

/**
 * Push AM authentication trees (journeys) from
 * `configDir/realms/<realm>/journeys/`. PageNode sub-nodes pushed first,
 * then top-level nodes, then the tree itself. InnerTreeEvaluatorNodes
 * cascade when `pushInnerJourneys` is true (default when no `name` is set).
 */
export async function pushJourneys(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  name?: string;
  pushInnerJourneys?: boolean;
  pushScripts?: boolean;
  log?: (line: string) => void;
}): Promise<void> {
  await journeysPush.updateAuthTrees(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const flatPull = require("./pull/idm-flat-config.js") as {
  pullIdmFlatConfig: (opts: {
    exportDir: string;
    subdir: string;
    filename: string;
    endpointName: string;
    tenantUrl: string;
    token: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const flatPush = require("./push/idm-flat-config.js") as {
  pushIdmFlatConfig: (opts: {
    configDir: string;
    subdir: string;
    filename: string;
    endpointName: string;
    tenantUrl: string;
    token: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

/**
 * Project scope → IDM flat-config endpoint mapping. Matches upstream fr-config-
 * manager's per-scope push/pull scripts byte-for-byte (dir names, filenames,
 * and endpoint paths).
 */
export const IDM_FLAT_SCOPES = {
  "access-config":       { subdir: "access-config",             filename: "access.json",             endpointName: "access" },
  "audit":               { subdir: "audit",                     filename: "audit.json",              endpointName: "audit" },
  "idm-authentication":  { subdir: "idm-authentication-config", filename: "authentication.json",     endpointName: "authentication" },
  "kba":                 { subdir: "kba",                       filename: "selfservice.kba.json",    endpointName: "selfservice.kba" },
  "ui-config":           { subdir: "ui",                        filename: "ui-configuration.json",   endpointName: "ui/configuration" },
} as const;

export type IdmFlatScope = keyof typeof IDM_FLAT_SCOPES;

export function isIdmFlatScope(s: string): s is IdmFlatScope {
  return Object.prototype.hasOwnProperty.call(IDM_FLAT_SCOPES, s);
}

export async function pullIdmFlatScope(opts: {
  scope: IdmFlatScope;
  exportDir: string;
  tenantUrl: string;
  token: string;
  log?: (line: string) => void;
}): Promise<void> {
  const cfg = IDM_FLAT_SCOPES[opts.scope];
  await flatPull.pullIdmFlatConfig({ ...cfg, exportDir: opts.exportDir, tenantUrl: opts.tenantUrl, token: opts.token, log: opts.log });
}

export async function pushIdmFlatScope(opts: {
  scope: IdmFlatScope;
  configDir: string;
  tenantUrl: string;
  token: string;
  log?: (line: string) => void;
}): Promise<void> {
  const cfg = IDM_FLAT_SCOPES[opts.scope];
  await flatPush.pushIdmFlatConfig({ ...cfg, configDir: opts.configDir, tenantUrl: opts.tenantUrl, token: opts.token, log: opts.log });
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const passwordPolicyPull = require("./pull/password-policy.js") as {
  pullPasswordPolicy: (opts: {
    exportDir: string;
    tenantUrl: string;
    token: string;
    realms?: string[];
    log?: (line: string) => void;
  }) => Promise<void>;
};

export async function pullPasswordPolicy(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  log?: (line: string) => void;
}): Promise<void> {
  await passwordPolicyPull.pullPasswordPolicy(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const passwordPolicyPush = require("./push/update-password-policy.js") as {
  pushPasswordPolicy: (opts: {
    configDir: string;
    tenantUrl: string;
    token: string;
    realms?: string[];
    log?: (line: string) => void;
  }) => Promise<void>;
};

export async function pushPasswordPolicy(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  log?: (line: string) => void;
}): Promise<void> {
  await passwordPolicyPush.pushPasswordPolicy(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const orgPrivilegesPull = require("./pull/org-privileges.js") as {
  pullOrgPrivileges: (opts: {
    exportDir: string;
    tenantUrl: string;
    token: string;
    name?: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

export async function pullOrgPrivileges(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await orgPrivilegesPull.pullOrgPrivileges(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const orgPrivilegesPush = require("./push/update-org-privileges.js") as {
  pushOrgPrivileges: (opts: {
    configDir: string;
    tenantUrl: string;
    token: string;
    name?: string;
    log?: (line: string) => void;
  }) => Promise<void>;
};

export async function pushOrgPrivileges(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await orgPrivilegesPush.pushOrgPrivileges(opts);
}

// ── cookie-domains ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieDomainsPull = require("./pull/cookie-domains.js") as {
  pullCookieDomains: (opts: { exportDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullCookieDomains(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  log?: (line: string) => void;
}): Promise<void> {
  await cookieDomainsPull.pullCookieDomains(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieDomainsPush = require("./push/update-cookie-domains.js") as {
  pushCookieDomains: (opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushCookieDomains(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  log?: (line: string) => void;
}): Promise<void> {
  await cookieDomainsPush.pushCookieDomains(opts);
}

// ── cors ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const corsPull = require("./pull/cors.js") as {
  pullCors: (opts: { exportDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullCors(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  log?: (line: string) => void;
}): Promise<void> {
  await corsPull.pullCors(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const corsPush = require("./push/update-cors.js") as {
  pushCors: (opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushCors(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  log?: (line: string) => void;
}): Promise<void> {
  await corsPush.pushCors(opts);
}

// ── csp ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cspPull = require("./pull/csp.js") as {
  pullCsp: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullCsp(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await cspPull.pullCsp(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cspPush = require("./push/update-csp.js") as {
  pushCsp: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushCsp(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await cspPush.pushCsp(opts);
}

// ── locales ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const localesPull = require("./pull/locales.js") as {
  pullLocales: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullLocales(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await localesPull.pullLocales(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const localesPush = require("./push/update-locales.js") as {
  pushLocales: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushLocales(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await localesPush.pushLocales(opts);
}

// ── endpoints ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const endpointsPull = require("./pull/endpoints.js") as {
  pullEndpoints: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullEndpoints(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await endpointsPull.pullEndpoints(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const endpointsPush = require("./push/update-idm-endpoints.js") as {
  pushEndpoints: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushEndpoints(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await endpointsPush.pushEndpoints(opts);
}

// ── internal-roles ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const internalRolesPull = require("./pull/internal-roles.js") as {
  pullInternalRoles: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullInternalRoles(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await internalRolesPull.pullInternalRoles(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const internalRolesPush = require("./push/update-internal-roles.js") as {
  pushInternalRoles: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushInternalRoles(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await internalRolesPush.pushInternalRoles(opts);
}

// ── email-templates ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const emailTemplatesPull = require("./pull/email-templates.js") as {
  pullEmailTemplates: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullEmailTemplates(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await emailTemplatesPull.pullEmailTemplates(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const emailTemplatesPush = require("./push/update-email-templates.js") as {
  pushEmailTemplates: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushEmailTemplates(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await emailTemplatesPush.pushEmailTemplates(opts);
}

// ── custom-nodes ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const customNodesPull = require("./pull/custom-nodes.js") as {
  pullCustomNodes: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullCustomNodes(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await customNodesPull.pullCustomNodes(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const customNodesPush = require("./push/update-custom-nodes.js") as {
  pushCustomNodes: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushCustomNodes(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await customNodesPush.pushCustomNodes(opts);
}

// ── themes ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const themesPull = require("./pull/themes.js") as {
  pullThemes: (opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pullThemes(opts: {
  exportDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await themesPull.pullThemes(opts);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const themesPush = require("./push/update-themes.js") as {
  pushThemes: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};

export async function pushThemes(opts: {
  configDir: string;
  tenantUrl: string;
  token: string;
  realms?: string[];
  name?: string;
  log?: (line: string) => void;
}): Promise<void> {
  await themesPush.pushThemes(opts);
}

// ── email-provider ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const emailProviderPull = require("./pull/email-provider.js") as {
  pullEmailProvider: (opts: { exportDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullEmailProvider(opts: { exportDir: string; tenantUrl: string; token: string; log?: (line: string) => void }): Promise<void> {
  await emailProviderPull.pullEmailProvider(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const emailProviderPush = require("./push/update-email-provider.js") as {
  pushEmailProvider: (opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushEmailProvider(opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }): Promise<void> {
  await emailProviderPush.pushEmailProvider(opts);
}

// ── schedules ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schedulesPull = require("./pull/schedules.js") as {
  pullSchedules: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullSchedules(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await schedulesPull.pullSchedules(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schedulesPush = require("./push/update-idm-schedules.js") as {
  pushSchedules: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushSchedules(opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await schedulesPush.pushSchedules(opts);
}

// ── iga-workflows ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const igaWorkflowsPull = require("./pull/iga-workflows.js") as {
  pullIgaWorkflows: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; includeImmutable?: boolean; log?: (line: string) => void }) => Promise<void>;
};
export async function pullIgaWorkflows(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; includeImmutable?: boolean; log?: (line: string) => void }): Promise<void> {
  await igaWorkflowsPull.pullIgaWorkflows(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const igaWorkflowsPush = require("./push/update-iga-workflows.js") as {
  pushIgaWorkflows: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; draft?: boolean; log?: (line: string) => void }) => Promise<void>;
};
export async function pushIgaWorkflows(opts: { configDir: string; tenantUrl: string; token: string; name?: string; draft?: boolean; log?: (line: string) => void }): Promise<void> {
  await igaWorkflowsPush.pushIgaWorkflows(opts);
}

// ── terms-and-conditions ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const termsPull = require("./pull/terms-and-conditions.js") as {
  pullTermsAndConditions: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullTermsAndConditions(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await termsPull.pullTermsAndConditions(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const termsPush = require("./push/update-terms-and-conditions.js") as {
  pushTermsAndConditions: (opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushTermsAndConditions(opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }): Promise<void> {
  await termsPush.pushTermsAndConditions(opts);
}

// ── service-objects ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const serviceObjectsPull = require("./pull/service-objects.js") as {
  pullServiceObjects: (opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullServiceObjects(opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }): Promise<void> {
  await serviceObjectsPull.pullServiceObjects(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const serviceObjectsPush = require("./push/update-service-objects.js") as {
  pushServiceObjects: (opts: { configDir: string; tenantUrl: string; token: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushServiceObjects(opts: { configDir: string; tenantUrl: string; token: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await serviceObjectsPush.pushServiceObjects(opts);
}

// ── raw ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawPull = require("./pull/raw.js") as {
  pullRawConfig: (opts: { exportDir: string; tenantUrl: string; token: string; requestedPath?: string; requestedPushApiVersion?: { protocol: string; resource: string }; descriptorFile?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullRawConfig(opts: { exportDir: string; tenantUrl: string; token: string; requestedPath?: string; requestedPushApiVersion?: { protocol: string; resource: string }; descriptorFile?: string; log?: (line: string) => void }): Promise<void> {
  await rawPull.pullRawConfig(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawPush = require("./push/update-raw.js") as {
  pushRawConfig: (opts: { configDir: string; tenantUrl: string; token: string; requestedPath?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushRawConfig(opts: { configDir: string; tenantUrl: string; token: string; requestedPath?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await rawPush.pushRawConfig(opts);
}

// ── authz-policies ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const authzPull = require("./pull/authz-policies.js") as {
  pullAuthzPolicies: (opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullAuthzPolicies(opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }): Promise<void> {
  await authzPull.pullAuthzPolicies(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const authzPush = require("./push/update-policies.js") as {
  pushAuthzPolicies: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; log?: (line: string) => void }) => Promise<void>;
};
export async function pushAuthzPolicies(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; log?: (line: string) => void }): Promise<void> {
  await authzPush.pushAuthzPolicies(opts);
}

// ── oauth2-agents ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentsPull = require("./pull/oauth2-agents.js") as {
  pullOauth2Agents: (opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullOauth2Agents(opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }): Promise<void> {
  await agentsPull.pullOauth2Agents(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentsPush = require("./push/update-agents.js") as {
  pushOauth2Agents: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushOauth2Agents(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await agentsPush.pushOauth2Agents(opts);
}

// ── services ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const servicesPull = require("./pull/services.js") as {
  pullServices: (opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullServices(opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }): Promise<void> {
  await servicesPull.pullServices(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const servicesPush = require("./push/update-services.js") as {
  pushServices: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushServices(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }): Promise<void> {
  await servicesPush.pushServices(opts);
}

// ── telemetry ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const telemetryPull = require("./pull/telemetry.js") as {
  pullTelemetry: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; category?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullTelemetry(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; category?: string; log?: (line: string) => void }): Promise<void> {
  await telemetryPull.pullTelemetry(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const telemetryPush = require("./push/update-telemetry.js") as {
  pushTelemetry: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; category?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushTelemetry(opts: { configDir: string; tenantUrl: string; token: string; name?: string; category?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await telemetryPush.pushTelemetry(opts);
}

// ── connector-definitions ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const connectorDefsPull = require("./pull/connector-definitions.js") as {
  pullConnectorDefinitions: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullConnectorDefinitions(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await connectorDefsPull.pullConnectorDefinitions(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const connectorDefsPush = require("./push/update-connector-definitions.js") as {
  pushConnectorDefinitions: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushConnectorDefinitions(opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await connectorDefsPush.pushConnectorDefinitions(opts);
}

// ── connector-mappings ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const connectorMappingsPull = require("./pull/connector-mappings.js") as {
  pullConnectorMappings: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullConnectorMappings(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await connectorMappingsPull.pullConnectorMappings(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const connectorMappingsPush = require("./push/update-connector-mappings.js") as {
  pushConnectorMappings: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushConnectorMappings(opts: { configDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await connectorMappingsPush.pushConnectorMappings(opts);
}

// ── remote-servers ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const remoteServersPull = require("./pull/remote-servers.js") as {
  pullRemoteServers: (opts: { exportDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullRemoteServers(opts: { exportDir: string; tenantUrl: string; token: string; log?: (line: string) => void }): Promise<void> {
  await remoteServersPull.pullRemoteServers(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const remoteServersPush = require("./push/update-remote-servers.js") as {
  pushRemoteServers: (opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushRemoteServers(opts: { configDir: string; tenantUrl: string; token: string; log?: (line: string) => void }): Promise<void> {
  await remoteServersPush.pushRemoteServers(opts);
}

// ── secrets ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const secretsPull = require("./pull/secrets.js") as {
  pullSecrets: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; activeOnly?: boolean; log?: (line: string) => void }) => Promise<void>;
};
export async function pullSecrets(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; activeOnly?: boolean; log?: (line: string) => void }): Promise<void> {
  await secretsPull.pullSecrets(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const secretsPush = require("./push/update-secrets.js") as {
  pushSecrets: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; prune?: boolean; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushSecrets(opts: { configDir: string; tenantUrl: string; token: string; name?: string; prune?: boolean; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await secretsPush.pushSecrets(opts);
}

// ── secret-mappings ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const secretMappingsPull = require("./pull/secret-mappings.js") as {
  pullSecretMappings: (opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullSecretMappings(opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }): Promise<void> {
  await secretMappingsPull.pullSecretMappings(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const secretMappingsPush = require("./push/update-secret-mappings.js") as {
  pushSecretMappings: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushSecretMappings(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }): Promise<void> {
  await secretMappingsPush.pushSecretMappings(opts);
}

// ── saml ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const samlPull = require("./pull/saml.js") as {
  pullSaml: (opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullSaml(opts: { exportDir: string; tenantUrl: string; token: string; descriptorFile?: string; log?: (line: string) => void }): Promise<void> {
  await samlPull.pullSaml(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const samlPush = require("./push/update-saml.js") as {
  pushSaml: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushSaml(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await samlPush.pushSaml(opts);
}

// ── variables (ESV) ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const variablesPull = require("./pull/variables.js") as {
  pullVariables: (opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullVariables(opts: { exportDir: string; tenantUrl: string; token: string; name?: string; log?: (line: string) => void }): Promise<void> {
  await variablesPull.pullVariables(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const variablesPush = require("./push/update-variables.js") as {
  pushVariables: (opts: { configDir: string; tenantUrl: string; token: string; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushVariables(opts: { configDir: string; tenantUrl: string; token: string; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await variablesPush.pushVariables(opts);
}

// ── am-agents ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const amAgentsPull = require("./pull/am-agents.js") as {
  pullAmAgents: (opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullAmAgents(opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }): Promise<void> {
  await amAgentsPull.pullAmAgents(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const amAgentsPush = require("./push/update-am-agents.js") as {
  pushAmAgents: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushAmAgents(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await amAgentsPush.pushAmAgents(opts);
}

// ── oidc-providers ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const oidcProvidersPull = require("./pull/oidc-providers.js") as {
  pullOidcProviders: (opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullOidcProviders(opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; log?: (line: string) => void }): Promise<void> {
  await oidcProvidersPull.pullOidcProviders(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const oidcProvidersPush = require("./push/update-oidc-providers.js") as {
  pushOidcProviders: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }) => Promise<void>;
};
export async function pushOidcProviders(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; name?: string; envVars?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<void> {
  await oidcProvidersPush.pushOidcProviders(opts);
}

// ── AM realm-config (generic — powers "authentication" scope today) ──────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const amRealmPull = require("./pull/am-realm-config.js") as {
  pullAmRealmConfig: (opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; configName: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pullAmRealmConfig(opts: { exportDir: string; tenantUrl: string; token: string; realms?: string[]; configName: string; log?: (line: string) => void }): Promise<void> {
  await amRealmPull.pullAmRealmConfig(opts);
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const amRealmPush = require("./push/update-am-realm-config.js") as {
  pushAmRealmConfig: (opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; configName: string; log?: (line: string) => void }) => Promise<void>;
};
export async function pushAmRealmConfig(opts: { configDir: string; tenantUrl: string; token: string; realms?: string[]; configName: string; log?: (line: string) => void }): Promise<void> {
  await amRealmPush.pushAmRealmConfig(opts);
}

// ── Direct-control / DCC mode toggle ─────────────────────────────────────────
// Flipping this to `true` makes every subsequent restClient call carry
// `X-Configuration-Type: mutable` so AIC routes the writes through an open
// direct-configuration session. Match each setDirectControlMode(true) with
// a setDirectControlMode(false) in a finally block.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const restClient = require("./common/restClient.js") as {
  setDirectControlMode: (on: boolean) => void;
  getDirectControlMode: () => boolean;
};
export const setDirectControlMode = restClient.setDirectControlMode;
export const getDirectControlMode = restClient.getDirectControlMode;
