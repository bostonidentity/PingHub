/**
 * In-process dispatcher: routes `fr-config-pull` / `fr-config-push` calls for
 * a given scope to the corresponding vendored function. Replaces the need to
 * spawn the fr-config-manager CLI for every promote / pull / compare action.
 *
 * The function shape matches a single `subEntry` run inside spawnFrConfig —
 * it takes the scope, args, env vars, env-dir cwd; emits stdout-style log
 * lines via the provided callback; returns an exit code (0 on success,
 * non-zero on error). No child process is created.
 */

import path from "node:path";
import fs from "node:fs";
import { parseEnvFile } from "@/lib/env-parser";
import { getAccessToken } from "@/lib/iga-api";
import * as vendor from "@/vendor/fr-config-manager";

export interface DispatchInput {
  /** "fr-config-pull" or "fr-config-push" */
  command: string;
  scope: string;
  /** ENV vars merged for this run (process.env + .env file + overrides). */
  envVars: Record<string, string | undefined>;
  /** Working directory (environments/<env>). */
  envDir: string;
  /** CLI args after the scope (e.g. `["--name", "myJourney"]`). */
  extraArgs: string[];
  /** filenameFilter etc. */
  extraEnv: Record<string, string>;
  emit: (data: string, type: "stdout" | "stderr") => void;
  /**
   * Optional pre-acquired bearer token. When provided, skips the
   * getAccessToken() call — lets a caller share one token across many
   * dispatches in the same pull/push run (spawnFrConfig does this).
   */
  token?: string;
}

export interface DispatchResult {
  /** true = dispatcher handled the call in-process. false = caller should fall back to spawn. */
  handled: boolean;
  /** Exit code (0 success). */
  code?: number;
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function configDirOf(envVars: Record<string, string | undefined>, envDir: string): string {
  return path.resolve(envDir, envVars.CONFIG_DIR ?? "./config");
}

function realmsOf(envVars: Record<string, string | undefined>): string[] {
  if (!envVars.REALMS) return ["alpha"];
  try {
    const parsed = JSON.parse(envVars.REALMS);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : ["alpha"];
  } catch {
    return ["alpha"];
  }
}

function prefixesOf(envVars: Record<string, string | undefined>): string[] {
  if (!envVars.SCRIPT_PREFIXES) return [""];
  try {
    const parsed = JSON.parse(envVars.SCRIPT_PREFIXES);
    return Array.isArray(parsed) ? parsed : [""];
  } catch {
    return [""];
  }
}

function descriptorOf(envVars: Record<string, string | undefined>, envDir: string, key: string): string | undefined {
  const v = envVars[key];
  if (!v) return undefined;
  const resolved = path.resolve(envDir, v);
  return fs.existsSync(resolved) ? resolved : undefined;
}

/** Split filenameFilter ("a,b,c") into a list of items. */
function itemsFromFilter(filter: string | undefined): string[] | null {
  if (!filter) return null;
  const items = filter.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

export async function dispatchFrConfig(input: DispatchInput): Promise<DispatchResult> {
  const { command, scope, envVars, envDir, extraArgs, extraEnv, emit } = input;
  if (command !== "fr-config-pull" && command !== "fr-config-push") {
    return { handled: false };
  }

  const tenantUrl = envVars.TENANT_BASE_URL ?? "";
  if (!tenantUrl) {
    emit(`dispatch: TENANT_BASE_URL missing for scope ${scope}\n`, "stderr");
    return { handled: true, code: 1 };
  }

  const exportDir = configDirOf(envVars, envDir);
  const configDir = exportDir;
  const realms = realmsOf(envVars);
  const name = parseArg(extraArgs, "--name");
  const category = parseArg(extraArgs, "--category");
  const filterItems = itemsFromFilter(extraEnv.filenameFilter);
  const log = (line: string) => emit(line, "stdout");

  // Reuse the caller's pre-acquired token when available; otherwise fetch
  // one lazily via getAccessToken(). Callers that run many scopes in a row
  // (spawnFrConfig) pass a shared token so the JWT exchange only happens once.
  let token: string | null = input.token ?? null;
  const getToken = async () => {
    if (token) return token;
    try {
      token = await getAccessToken(
        envVars as Record<string, string>,
        (msg) => emit(`[token] ${msg}\n`, "stderr"),
      );
      return token;
    } catch (err) {
      emit(`dispatch: token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, "stderr");
      throw err;
    }
  };

  // When the caller passed --direct-control (controlled-env DCC promote),
  // flip the vendored restClient into mutable mode so every PUT/POST/DELETE
  // it issues carries `X-Configuration-Type: mutable` and AIC routes the
  // write through the open direct-configuration session. Reset in finally.
  const directControl = extraArgs.includes("--direct-control");
  if (directControl) {
    vendor.setDirectControlMode(true);
    emit(`[dispatch] ${scope}: X-Configuration-Type: mutable enabled (DCC session)\n`, "stderr");
  }

  try {
    const t = await getToken();

    // Push + pull for each scope. Dispatch by (command, scope).
    if (command === "fr-config-pull") {
      if (vendor.isIdmFlatScope(scope)) {
        await vendor.pullIdmFlatScope({ scope, exportDir, tenantUrl, token: t, log });
        return { handled: true, code: 0 };
      }
      switch (scope) {
        case "managed-objects":
          for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
            await vendor.pullManagedObjects({ exportDir, tenantUrl, token: t, name: n, log });
          }
          return { handled: true, code: 0 };
        case "scripts": {
          // Items may arrive as bare names, `<uuid>.json` filenames, or
          // `name:<n>` tags (the original task-item form that survives when
          // promote-items Step 0 can't resolve the name to a UUID). Strip
          // both decorations so the vendored pull matches by name OR _id.
          const rawItems = filterItems ?? (name ? [name] : null);
          const cleaned = rawItems?.map((it) =>
            it.startsWith("name:") ? it.slice(5)
            : it.endsWith(".json") ? it.slice(0, -5)
            : it
          );
          // Single call regardless of item count — vendor.pullScripts now
          // batches them into one fetch + in-memory filter (was N fetches).
          await vendor.pullScripts({
            exportDir,
            tenantUrl,
            token: t,
            realms,
            prefixes: prefixesOf(envVars),
            name: cleaned ?? undefined,
            log,
          });
          return { handled: true, code: 0 };
        }
        case "journeys":
          for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
            await vendor.pullJourneys({ exportDir, tenantUrl, token: t, realms, name: n, pullDependencies: false, log });
          }
          return { handled: true, code: 0 };
        case "password-policy":
          await vendor.pullPasswordPolicy({ exportDir, tenantUrl, token: t, realms, log });
          return { handled: true, code: 0 };
        case "org-privileges":
          await vendor.pullOrgPrivileges({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "cookie-domains":
          await vendor.pullCookieDomains({ exportDir, tenantUrl, token: t, log });
          return { handled: true, code: 0 };
        case "cors":
          await vendor.pullCors({ exportDir, tenantUrl, token: t, log });
          return { handled: true, code: 0 };
        case "csp":
          await vendor.pullCsp({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "locales":
          await vendor.pullLocales({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "endpoints":
          for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
            await vendor.pullEndpoints({ exportDir, tenantUrl, token: t, name: n, log });
          }
          return { handled: true, code: 0 };
        case "internal-roles":
          await vendor.pullInternalRoles({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "email-templates":
          await vendor.pullEmailTemplates({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "custom-nodes":
          for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
            await vendor.pullCustomNodes({ exportDir, tenantUrl, token: t, name: n, log });
          }
          return { handled: true, code: 0 };
        case "themes":
          await vendor.pullThemes({ exportDir, tenantUrl, token: t, realms, name, log });
          return { handled: true, code: 0 };
        case "email-provider":
          await vendor.pullEmailProvider({ exportDir, tenantUrl, token: t, log });
          return { handled: true, code: 0 };
        case "schedules":
          for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
            await vendor.pullSchedules({ exportDir, tenantUrl, token: t, name: n, log });
          }
          return { handled: true, code: 0 };
        case "iga-workflows":
          await vendor.pullIgaWorkflows({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "terms-and-conditions":
          await vendor.pullTermsAndConditions({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "service-objects":
          await vendor.pullServiceObjects({ exportDir, tenantUrl, token: t, descriptorFile: descriptorOf(envVars, envDir, "SERVICE_OBJECTS_CONFIG_FILE"), log });
          return { handled: true, code: 0 };
        case "authz-policies":
          await vendor.pullAuthzPolicies({ exportDir, tenantUrl, token: t, descriptorFile: descriptorOf(envVars, envDir, "POLICY_SETS_CONFIG_FILE"), log });
          return { handled: true, code: 0 };
        case "oauth2-agents":
          await vendor.pullOauth2Agents({ exportDir, tenantUrl, token: t, descriptorFile: descriptorOf(envVars, envDir, "AGENTS_CONFIG_FILE"), log });
          return { handled: true, code: 0 };
        case "services":
          await vendor.pullServices({ exportDir, tenantUrl, token: t, realms, name, log });
          return { handled: true, code: 0 };
        case "telemetry":
          await vendor.pullTelemetry({ exportDir, tenantUrl, token: t, name, category, log });
          return { handled: true, code: 0 };
        case "connector-definitions":
          await vendor.pullConnectorDefinitions({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "connector-mappings":
          await vendor.pullConnectorMappings({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "remote-servers":
          await vendor.pullRemoteServers({ exportDir, tenantUrl, token: t, log });
          return { handled: true, code: 0 };
        case "secrets":
          await vendor.pullSecrets({ exportDir, tenantUrl, token: t, name, activeOnly: true, log });
          return { handled: true, code: 0 };
        case "secret-mappings":
          await vendor.pullSecretMappings({ exportDir, tenantUrl, token: t, realms, name, log });
          return { handled: true, code: 0 };
        case "saml":
          await vendor.pullSaml({ exportDir, tenantUrl, token: t, descriptorFile: descriptorOf(envVars, envDir, "SAML_CONFIG_FILE"), log });
          return { handled: true, code: 0 };
        case "variables":
          await vendor.pullVariables({ exportDir, tenantUrl, token: t, name, log });
          return { handled: true, code: 0 };
        case "am-agents":
          await vendor.pullAmAgents({ exportDir, tenantUrl, token: t, realms, name, log });
          return { handled: true, code: 0 };
        case "oidc-providers":
          await vendor.pullOidcProviders({ exportDir, tenantUrl, token: t, realms, name, log });
          return { handled: true, code: 0 };
        case "authentication":
          await vendor.pullAmRealmConfig({ exportDir, tenantUrl, token: t, realms, configName: "authentication", log });
          return { handled: true, code: 0 };
        case "config-metadata":
          // Display-only metadata; no on-disk representation. No-op.
          emit(`config-metadata: display-only, nothing to pull\n`, "stdout");
          return { handled: true, code: 0 };
        default:
          return { handled: false };
      }
    }

    // command === "fr-config-push"
    if (vendor.isIdmFlatScope(scope)) {
      await vendor.pushIdmFlatScope({ scope, configDir, tenantUrl, token: t, log });
      return { handled: true, code: 0 };
    }
    switch (scope) {
      case "managed-objects":
        for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
          await vendor.pushManagedObjects({ configDir, tenantUrl, token: t, name: n, log });
        }
        return { handled: true, code: 0 };
      case "scripts":
        for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
          await vendor.pushScripts({ configDir, tenantUrl, token: t, realms, name: n, log });
        }
        return { handled: true, code: 0 };
      case "journeys":
        for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
          await vendor.pushJourneys({ configDir, tenantUrl, token: t, realms, name: n, pushInnerJourneys: !n, pushScripts: false, log });
        }
        return { handled: true, code: 0 };
      case "password-policy":
        await vendor.pushPasswordPolicy({ configDir, tenantUrl, token: t, realms, log });
        return { handled: true, code: 0 };
      case "org-privileges":
        await vendor.pushOrgPrivileges({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "cookie-domains":
        await vendor.pushCookieDomains({ configDir, tenantUrl, token: t, log });
        return { handled: true, code: 0 };
      case "cors":
        await vendor.pushCors({ configDir, tenantUrl, token: t, log });
        return { handled: true, code: 0 };
      case "csp":
        await vendor.pushCsp({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "locales":
        await vendor.pushLocales({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "endpoints":
        for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
          await vendor.pushEndpoints({ configDir, tenantUrl, token: t, name: n, log });
        }
        return { handled: true, code: 0 };
      case "internal-roles":
        await vendor.pushInternalRoles({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "email-templates":
        await vendor.pushEmailTemplates({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "custom-nodes":
        for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
          await vendor.pushCustomNodes({ configDir, tenantUrl, token: t, name: n, log });
        }
        return { handled: true, code: 0 };
      case "themes":
        await vendor.pushThemes({ configDir, tenantUrl, token: t, realms, name, log });
        return { handled: true, code: 0 };
      case "email-provider":
        await vendor.pushEmailProvider({ configDir, tenantUrl, token: t, log });
        return { handled: true, code: 0 };
      case "schedules":
        for (const n of (filterItems ?? (name ? [name] : [undefined as string | undefined]))) {
          await vendor.pushSchedules({ configDir, tenantUrl, token: t, name: n, log });
        }
        return { handled: true, code: 0 };
      case "iga-workflows":
        await vendor.pushIgaWorkflows({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "terms-and-conditions":
        await vendor.pushTermsAndConditions({ configDir, tenantUrl, token: t, log });
        return { handled: true, code: 0 };
      case "service-objects":
        await vendor.pushServiceObjects({ configDir, tenantUrl, token: t, envVars, log });
        return { handled: true, code: 0 };
      case "authz-policies":
        await vendor.pushAuthzPolicies({ configDir, tenantUrl, token: t, realms, log });
        return { handled: true, code: 0 };
      case "oauth2-agents":
        await vendor.pushOauth2Agents({ configDir, tenantUrl, token: t, realms, envVars, log });
        return { handled: true, code: 0 };
      case "services":
        await vendor.pushServices({ configDir, tenantUrl, token: t, realms, name, log });
        return { handled: true, code: 0 };
      case "telemetry":
        await vendor.pushTelemetry({ configDir, tenantUrl, token: t, name, category, envVars, log });
        return { handled: true, code: 0 };
      case "connector-definitions":
        await vendor.pushConnectorDefinitions({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "connector-mappings":
        await vendor.pushConnectorMappings({ configDir, tenantUrl, token: t, name, log });
        return { handled: true, code: 0 };
      case "remote-servers":
        await vendor.pushRemoteServers({ configDir, tenantUrl, token: t, log });
        return { handled: true, code: 0 };
      case "secrets":
        await vendor.pushSecrets({ configDir, tenantUrl, token: t, name, envVars, log });
        return { handled: true, code: 0 };
      case "secret-mappings":
        await vendor.pushSecretMappings({ configDir, tenantUrl, token: t, realms, name, log });
        return { handled: true, code: 0 };
      case "saml":
        await vendor.pushSaml({ configDir, tenantUrl, token: t, realms, name, envVars, log });
        return { handled: true, code: 0 };
      case "variables":
        await vendor.pushVariables({ configDir, tenantUrl, token: t, name, envVars, log });
        return { handled: true, code: 0 };
      case "am-agents":
        await vendor.pushAmAgents({ configDir, tenantUrl, token: t, realms, name, envVars, log });
        return { handled: true, code: 0 };
      case "oidc-providers":
        await vendor.pushOidcProviders({ configDir, tenantUrl, token: t, realms, name, envVars, log });
        return { handled: true, code: 0 };
      case "authentication":
        await vendor.pushAmRealmConfig({ configDir, tenantUrl, token: t, realms, configName: "authentication", log });
        return { handled: true, code: 0 };
      case "config-metadata":
        emit(`config-metadata: display-only, nothing to push\n`, "stdout");
        return { handled: true, code: 0 };
      default:
        return { handled: false };
    }
  } catch (err) {
    emit(`${err instanceof Error ? err.message : String(err)}\n`, "stderr");
    return { handled: true, code: 1 };
  } finally {
    if (directControl) vendor.setDirectControlMode(false);
  }
}

// Keep utilities for env-file reading (used by callers that need to resolve
// envVars before calling dispatchFrConfig).
export function loadEnvVars(envFilePath: string): Record<string, string> {
  if (!fs.existsSync(envFilePath)) return {};
  return parseEnvFile(fs.readFileSync(envFilePath, "utf-8"));
}
