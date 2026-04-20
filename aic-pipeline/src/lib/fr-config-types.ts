export type FrCommand = "fr-config-pull" | "fr-config-push";

/** Exact subcommand names accepted by fr-config-pull and fr-config-push */
export type ConfigScope =
  | "access-config"
  | "audit"
  | "authentication"
  | "authz-policies"
  | "config-metadata"
  | "connector-definitions"
  | "connector-mappings"
  | "cookie-domains"
  | "cors"
  | "csp"
  | "custom-nodes"
  | "email-provider"
  | "email-templates"
  | "endpoints"
  | "idm-authentication"
  | "iga-workflows"
  | "internal-roles"
  | "journeys"
  | "kba"
  | "locales"
  | "managed-objects"
  | "oauth2-agents"
  | "org-privileges"
  | "password-policy"
  | "remote-servers"
  | "saml"
  | "schedules"
  | "scripts"
  | "secret-mappings"
  | "secrets"
  | "service-objects"
  | "services"
  | "telemetry"
  | "terms-and-conditions"
  | "themes"
  | "ui-config"
  | "variables";

export type EnvironmentType = "sandbox" | "controlled";

export interface Environment {
  name: string;
  label: string;
  color: "blue" | "yellow" | "red" | "green" | "purple" | "orange" | "teal" | "pink" | "indigo" | "gray";
  type?: EnvironmentType;
  /** Only meaningful when type === "controlled". Indicates this is the first env in the pipeline. */
  devEnvironment?: boolean;
}

/** Scopes supporting file-level filtering via filenameFilter env var (comma-separated filenames) */
export const FILENAME_FILTER_SCOPES = ["scripts", "custom-nodes", "endpoints", "schedules"] as const satisfies readonly ConfigScope[];

/** Scopes supporting item-level filtering via --name flag (realm/directory name, one CLI run per item) */
export const NAME_FLAG_SCOPES = ["journeys", "managed-objects", "iga-workflows"] as const satisfies readonly ConfigScope[];

/** Union of all scopes that support sub-scope selection */
export const FILE_SELECTABLE_SCOPES: readonly ConfigScope[] = [...FILENAME_FILTER_SCOPES, ...NAME_FLAG_SCOPES];

export interface ScopeSelection {
  scope: ConfigScope;
  /** undefined = push all items; string[] = push only these items */
  items?: string[];
}

export interface RunOptions {
  command: FrCommand;
  environment: string;
  scopes?: ConfigScope[];
  /** Plan mode: per-scope item selection. Takes precedence over scopes when provided. */
  scopeSelections?: ScopeSelection[];
}

export type PromoteSubcommand =
  | "check-locked-status"
  | "lock-tenants"
  | "run-dryrun-promotion"
  | "run-promotion"
  | "check-promotion-status"
  | "check-promotion-reports"
  | "unlock-tenants"
  | "rollback";

export const PROMOTE_SUBCOMMANDS: {
  value: PromoteSubcommand;
  label: string;
  description: string;
  variant: "default" | "warning" | "danger" | "info";
}[] = [
  {
    value: "check-locked-status",
    label: "Check Locked Status",
    description: "Check whether the tenant is currently locked.",
    variant: "info",
  },
  {
    value: "lock-tenants",
    label: "Lock Tenants",
    description: "Lock the tenant before running a promotion.",
    variant: "warning",
  },
  {
    value: "run-dryrun-promotion",
    label: "Run Dry-Run Promotion",
    description: "Simulate a promotion without applying changes.",
    variant: "default",
  },
  {
    value: "check-promotion-reports",
    label: "Check Promotion Reports",
    description: "View the latest promotion report.",
    variant: "info",
  },
  {
    value: "run-promotion",
    label: "Run Promotion",
    description: "Apply the promotion — this modifies the target tenant.",
    variant: "danger",
  },
  {
    value: "check-promotion-status",
    label: "Check Promotion Status",
    description: "Poll the current promotion operation status.",
    variant: "info",
  },
  {
    value: "unlock-tenants",
    label: "Unlock Tenants",
    description: "Unlock the tenant after a promotion completes.",
    variant: "warning",
  },
  {
    value: "rollback",
    label: "Rollback",
    description: "Roll back the last promotion.",
    variant: "danger",
  },
];

/**
 * A scope entry in the CONFIG_SCOPES display list.
 * - `commandType: "fr-config"` (default) — managed by fr-config-manager CLI
 * - `commandType: "frodo"` — managed by Frodo CLI (frodo agent / frodo idp)
 * - `commandType: "iga-api"` — managed by direct IGA REST API calls
 * - `cliSupported: false` — not yet implemented by any tool (display only)
 */
export interface ScopeDisplayEntry {
  value: string;
  label: string;
  group: string;
  description: string;
  /** @default "fr-config" */
  commandType?: "fr-config" | "frodo" | "iga-api";
  /** @default true — false means no tool supports this scope yet */
  cliSupported?: boolean;
}

/**
 * Essentials scope mappings: each entry maps an Essentials label to the real scope value.
 * Toggling an Essentials checkbox mirrors to the real scope and vice versa.
 */
export const ESSENTIALS_SCOPES: { value: ConfigScope; label: string }[] = [
  { value: "access-config",      label: "Access Config" },
  { value: "endpoints",          label: "Custom Endpoints" },
  { value: "email-templates",    label: "Email Templates" },
  { value: "variables",          label: "ESVs" },
  { value: "idm-authentication", label: "IDM Authentication" },
  { value: "iga-workflows",     label: "IGA Workflows" },
  { value: "journeys",          label: "Journeys" },
  { value: "managed-objects",   label: "Managed Objects" },
  { value: "scripts",           label: "Scripts" },
];

export const CONFIG_SCOPES: ScopeDisplayEntry[] = [
  // Journeys & Auth
  { value: "journeys",         label: "Journeys",             group: "Journeys & Auth",   description: "Authentication journey trees and their node configurations" },
  { value: "scripts",          label: "Scripts",              group: "Journeys & Auth",   description: "Groovy/JavaScript scripts used within journey nodes and policies" },
  { value: "endpoints",        label: "Custom Endpoints",     group: "Connectors & IDM",  description: "Custom REST endpoints exposed via the IDM API" },
  // Identity & Access
  { value: "authentication",       label: "Authentication",          group: "Identity & Access", description: "Core AM authentication settings, modules, and chains" },
  { value: "custom-nodes",         label: "Custom Nodes",            group: "Identity & Access", description: "Custom journey node implementations (jar/script-backed)" },
  { value: "services",             label: "Services",                group: "Identity & Access", description: "AM service configurations (e.g. OAuth2, SAML, social providers)" },
  { value: "kba",                  label: "KBA",                     group: "Identity & Access", description: "Knowledge-based authentication security questions" },
  { value: "password-policy",      label: "Password Policy",         group: "Identity & Access", description: "Password strength, expiry, and history policies" },
  { value: "managed-objects",      label: "Managed Objects",         group: "Connectors & IDM",  description: "IDM managed object schema definitions (e.g. user, role, device)" },
  { value: "authz-policies",       label: "Authorization Policies",  group: "Identity & Access", description: "Policy sets and rules controlling access to resources" },
  { value: "access-config",        label: "Access Config",           group: "Connectors & IDM",  description: "AM access management global and realm-level settings" },
  { value: "internal-roles",       label: "Internal Roles",          group: "Identity & Access", description: "IDM internal roles and their assignments" },
  { value: "org-privileges",       label: "Org Privileges",          group: "Identity & Access", description: "Organization-level admin privileges and delegations" },
  { value: "terms-and-conditions", label: "Terms & Conditions",      group: "Identity & Access", description: "Versioned T&C agreements presented to users at login" },
  // Connectors & IDM
  { value: "connector-definitions", label: "Connector Definitions", group: "Connectors & IDM", description: "ICF connector configurations linking to external systems" },
  { value: "connector-mappings",    label: "Connector Mappings",    group: "Connectors & IDM", description: "Attribute mappings between IDM managed objects and connectors" },
  { value: "remote-servers",        label: "Remote Servers",        group: "Connectors & IDM", description: "Remote Connector Server (RCS) gateway configurations" },
  { value: "idm-authentication",    label: "IDM Authentication",    group: "Connectors & IDM", description: "IDM-side authentication module settings" },
  { value: "service-objects",       label: "Service Objects",       group: "Connectors & IDM", description: "IDM service objects used for system integrations" },
  // Federation
  { value: "oauth2-agents",   label: "OAuth2 Agents",   group: "Federation", description: "OAuth2/OIDC client registrations and agent configurations" },
  { value: "saml",            label: "SAML Entities",   group: "Federation", description: "SAML 2.0 identity and service provider entity configurations" },
  { value: "am-agents",       label: "AM Policy Agents", group: "Federation", description: "Web and Java AM policy agent configurations", commandType: "frodo" },
  { value: "oidc-providers",  label: "OIDC Providers",  group: "Federation", description: "External OIDC/social identity provider configurations", commandType: "frodo" },
  // Secrets & Variables
  { value: "secrets",         label: "Secrets",           group: "Secrets & Variables", description: "Secret labels and their active/inactive versions" },
  { value: "secret-mappings", label: "Secret Mappings",   group: "Secrets & Variables", description: "Mappings that bind secret labels to AM/IDM services" },
  { value: "variables",       label: "Variables (ESVs)",  group: "Secrets & Variables", description: "Environment-specific variables for tenant configuration", commandType: "frodo" },
  // UI & Comms
  { value: "themes",           label: "Themes",           group: "UI & Comms", description: "UI themes, logos, and branding for the login experience" },
  { value: "ui-config",        label: "UI Config",        group: "UI & Comms", description: "Platform UI global configuration and feature flags" },
  { value: "email-templates",  label: "Email Templates",  group: "UI & Comms", description: "Transactional email templates (password reset, registration, etc.)" },
  { value: "email-provider",   label: "Email Provider",   group: "UI & Comms", description: "SMTP / external email provider connection settings" },
  { value: "sms-provider",     label: "SMS Provider",     group: "UI & Comms", description: "SMS / OTP provider configuration for one-time passcode delivery (no tool support)", cliSupported: false },
  { value: "locales",          label: "Locales",          group: "UI & Comms", description: "Localization files and translation overrides" },
  // IGA
  { value: "iga-workflows",     label: "IGA Workflows",             group: "IGA", description: "Identity Governance and Administration workflow definitions" },
  { value: "iga-forms",         label: "IGA Forms",                 group: "IGA", description: "IGA request and approval form definitions used in access request workflows", commandType: "iga-api" },
  { value: "iga-notifications", label: "IGA Notifications",         group: "IGA", description: "IGA notification type definitions (certification, access request, etc.)", commandType: "iga-api" },
  { value: "iga-assignments",   label: "IGA Assignments",           group: "IGA", description: "Form-to-object assignment configurations linking request forms to workflows, managed objects, and roles", commandType: "iga-api" },
  // Infrastructure
  { value: "schedules",        label: "Schedules",        group: "Infrastructure", description: "Scheduled tasks and cron-style recurring jobs" },
  { value: "cors",             label: "CORS",             group: "Infrastructure", description: "Cross-Origin Resource Sharing policy settings" },
  { value: "csp",              label: "CSP",              group: "Infrastructure", description: "Content Security Policy headers for tenant pages" },
  { value: "cookie-domains",   label: "Cookie Domains",   group: "Infrastructure", description: "Allowed cookie domains for cross-domain SSO" },
  { value: "audit",            label: "Audit",            group: "Infrastructure", description: "Audit logging configuration and event handler settings" },
  { value: "telemetry",        label: "Telemetry",        group: "Infrastructure", description: "Usage telemetry and monitoring configuration" },
  { value: "config-metadata",  label: "Config Metadata",  group: "Infrastructure", description: "Pipeline metadata stored alongside pushed configuration (custom-config.metadata)" },
];
