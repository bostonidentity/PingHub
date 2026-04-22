import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnFrConfig, getConfigDir, getEnvFileContent } from "@/lib/fr-config";
import { dispatchFrConfig } from "@/lib/fr-config-dispatch";
import { parseEnvFile } from "@/lib/env-parser";
import type { ScopeSelection } from "@/lib/fr-config-types";
import { resolveJourneyDeps } from "@/lib/resolve-journey-deps";
import { getRealmRoots } from "@/lib/realm-paths";
import { pullManagedObjects, pushManagedObjects, pullScripts, pushScripts, pullJourneys, pushJourneys, isIdmFlatScope, pullIdmFlatScope, pushIdmFlatScope, pullPasswordPolicy, pushPasswordPolicy, pullOrgPrivileges, pushOrgPrivileges, pullCookieDomains, pushCookieDomains, pullCors, pushCors, pullCsp, pushCsp, pullLocales, pushLocales, pullEndpoints, pushEndpoints, pullInternalRoles, pushInternalRoles, pullEmailTemplates, pushEmailTemplates, pullCustomNodes, pushCustomNodes, pullThemes, pushThemes, pullEmailProvider, pushEmailProvider, pullSchedules, pushSchedules, pullIgaWorkflows, pushIgaWorkflows, pullTermsAndConditions, pushTermsAndConditions, pullServiceObjects, pushServiceObjects, pullRawConfig, pushRawConfig, pullAuthzPolicies, pushAuthzPolicies, pullOauth2Agents, pushOauth2Agents, pullServices, pushServices, pullTelemetry, pushTelemetry, pullConnectorDefinitions, pushConnectorDefinitions, pullConnectorMappings, pushConnectorMappings, pullRemoteServers, pushRemoteServers, pullSecrets, pushSecrets, pullSecretMappings, pushSecretMappings } from "@/vendor/fr-config-manager";
import { getAccessToken } from "@/lib/iga-api";

// ── Scope → directory mapping (mirrors push/audit route) ─────────────────────

const SCOPE_DIR: Record<string, string> = {
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

const REALM_SCOPE_SUBDIR: Record<string, string> = {
  "authz-policies": "authorization", "journeys": "journeys",
  "oauth2-agents": "realm-config/agents", "password-policy": "password-policy",
  "saml": "realm-config/saml", "scripts": "scripts",
  "secret-mappings": "secret-mappings", "services": "services", "themes": "themes",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function copyDirSync(src: string, dest: string) {
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
 * fr-config-manager push modules expect `realms/<realm>/<scope>/…`, so when
 * the source was pulled in the vendored-pull layout (`<realm>/<scope>/…`
 * without the `realms/` prefix), this prepends `realms/` for realm-scoped
 * scopes. Global scopes are left as-is.
 */
function stagingRelPath(configDir: string, srcDir: string, scope: string): string {
  const rel = path.relative(configDir, srcDir).split(path.sep).join("/");
  if ((scope in REALM_SCOPE_SUBDIR) && !rel.startsWith("realms/")) {
    return `realms/${rel}`;
  }
  return rel;
}

/** Resolve scope to absolute directory paths within a config dir. */
function resolveScopeDirs(configDir: string, scope: string): string[] {
  if (scope in REALM_SCOPE_SUBDIR) {
    const subdir = REALM_SCOPE_SUBDIR[scope];
    return getRealmRoots(configDir, subdir).map((root) => path.join(root, subdir));
  }
  const dirName = SCOPE_DIR[scope] ?? scope;
  const d = path.join(configDir, dirName);
  return fs.existsSync(d) ? [d] : [];
}

/**
 * Build a name → _id map by scanning JSON files in the given directories.
 * Works for scripts (scripts-config/*.json), journeys (journeyName/journeyName.json),
 * endpoints (endpointName/endpointName.js → same dir has .json), and generic JSON.
 */
function buildNameToIdMap(dirs: string[], scope: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of dirs) {
    if (scope === "scripts") {
      // Scripts: scripts-config/{uuid}.json → { name, _id }
      const configDir = path.join(dir, "scripts-config");
      if (!fs.existsSync(configDir)) continue;
      for (const f of fs.readdirSync(configDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const json = JSON.parse(fs.readFileSync(path.join(configDir, f), "utf-8"));
          if (json.name && json._id) map.set(json.name, json._id);
        } catch { /* skip */ }
      }
    } else if (scope === "journeys") {
      // Journeys: {journeyName}/{journeyName}.json — journeys are matched by directory name
      // No _id remapping needed for journeys — they use directory names
    } else {
      // Generic: scan for JSON files with _id and name fields
      const scanDir = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            // Check for a JSON file inside with the same name
            const inner = path.join(d, entry.name, `${entry.name}.json`);
            if (fs.existsSync(inner)) {
              try {
                const json = JSON.parse(fs.readFileSync(inner, "utf-8"));
                if (json._id) map.set(entry.name, json._id);
              } catch { /* skip */ }
            }
          } else if (entry.name.endsWith(".json")) {
            try {
              const json = JSON.parse(fs.readFileSync(path.join(d, entry.name), "utf-8"));
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
function remapIds(tempDirs: string[], scope: string, sourceNameToId: Map<string, string>, targetNameToId: Map<string, string>, logs: string[]) {
  if (scope === "scripts") {
    // Remap script configs
    for (const dir of tempDirs) {
      const configDir = path.join(dir, "scripts-config");
      if (!fs.existsSync(configDir)) continue;
      for (const f of fs.readdirSync(configDir)) {
        if (!f.endsWith(".json")) continue;
        const fp = path.join(configDir, f);
        try {
          const json = JSON.parse(fs.readFileSync(fp, "utf-8"));
          if (!json.name || !json._id) continue;
          const targetId = targetNameToId.get(json.name);
          if (targetId && targetId !== json._id) {
            const oldId = json._id;
            json._id = targetId;
            fs.writeFileSync(fp, JSON.stringify(json, null, 2));
            // Rename the file to match the new UUID
            const newFp = path.join(configDir, `${targetId}.json`);
            if (fp !== newFp) fs.renameSync(fp, newFp);
            logs.push(`Remapped script "${json.name}": ${oldId} → ${targetId}`);
          } else if (!targetId) {
            logs.push(`Script "${json.name}" not found on target — will be created with ID ${json._id}`);
          }
        } catch { /* skip */ }
      }
    }
  } else if (scope === "journeys") {
    // Journeys match by directory name — no _id remapping needed
    logs.push("Journeys matched by directory name — no ID remapping needed");
  } else {
    // Generic: remap _id in JSON files
    for (const dir of tempDirs) {
      const processDir = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            processDir(path.join(d, entry.name));
          } else if (entry.name.endsWith(".json")) {
            const fp = path.join(d, entry.name);
            try {
              const json = JSON.parse(fs.readFileSync(fp, "utf-8"));
              if (!json._id) continue;
              const name = json.name ?? path.basename(entry.name, ".json");
              const targetId = targetNameToId.get(name);
              if (targetId && targetId !== json._id) {
                const oldId = json._id;
                json._id = targetId;
                fs.writeFileSync(fp, JSON.stringify(json, null, 2));
                logs.push(`Remapped "${name}": ${oldId} → ${targetId}`);
              } else if (!targetId) {
                logs.push(`"${name}" not found on target — will be created`);
              }
            } catch { /* skip */ }
          }
        }
      };
      processDir(dir);
    }
  }
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sourceEnvironment, targetEnvironment, scopeSelections, includeDeps, directControl } = body as {
    sourceEnvironment: string;
    targetEnvironment: string;
    scopeSelections: ScopeSelection[];
    includeDeps?: boolean;
    /** When true, pass --direct-control to fr-config-push for /mutable endpoints */
    directControl?: boolean;
  };

  if (!sourceEnvironment || !targetEnvironment || !scopeSelections?.length) {
    return new Response("Missing parameters", { status: 400 });
  }

  const sourceConfigDir = getConfigDir(sourceEnvironment);
  const targetConfigDir = getConfigDir(targetEnvironment);
  if (!sourceConfigDir) return new Response("Source config dir not found", { status: 404 });
  if (!targetConfigDir) return new Response("Target config dir not found", { status: 404 });

  // Create temp copy of source config
  const tempDir = path.join(os.tmpdir(), `promote-${Date.now()}`);
  const tempConfigDir = path.join(tempDir, "config");

  // Get target environment's .env for CONFIG_DIR
  const targetEnvVars = parseEnvFile(getEnvFileContent(targetEnvironment));
  const targetConfigDirRel = targetEnvVars.CONFIG_DIR ?? "./config";


  const stream = new ReadableStream<string>({
    async start(controller) {
      const emit = (obj: object) => {
        controller.enqueue(JSON.stringify(obj) + "\n");
      };

      try {
        // Step 0: Resolve name: prefixed items to UUIDs
        for (const sel of scopeSelections) {
          if (sel.scope !== "scripts" || !sel.items) continue;
          const nameItems = sel.items.filter((id) => id.startsWith("name:"));
          if (nameItems.length === 0) continue;

          const sourceDirs = resolveScopeDirs(sourceConfigDir, "scripts");
          const nameToUuid = new Map<string, string>();
          for (const dir of sourceDirs) {
            const configDir = path.join(dir, "scripts-config");
            if (!fs.existsSync(configDir)) continue;
            for (const f of fs.readdirSync(configDir)) {
              if (!f.endsWith(".json")) continue;
              try {
                const json = JSON.parse(fs.readFileSync(path.join(configDir, f), "utf-8"));
                if (json.name) nameToUuid.set(json.name, f);
              } catch { /* skip */ }
            }
          }

          sel.items = sel.items.map((id) => {
            if (!id.startsWith("name:")) return id;
            const name = id.slice(5);
            const uuid = nameToUuid.get(name);
            return uuid ?? id;
          });
        }

        // Step 0b: Resolve journey dependencies if includeDeps is enabled
        if (includeDeps) {
          const journeyScopes = scopeSelections.filter((s) => s.scope === "journeys" && s.items?.length);
          if (journeyScopes.length > 0) {
            emit({ type: "scope-start", scope: "resolve-deps", ts: Date.now() });
            emit({ type: "stdout", data: "Resolving journey dependencies...\n", ts: Date.now() });

            const journeyNames = journeyScopes.flatMap((s) => s.items!);
            const deps = resolveJourneyDeps(sourceConfigDir, journeyNames);

            // Add sub-journeys to scopeSelections
            if (deps.subJourneys.length > 0) {
              const journeySel = scopeSelections.find((s) => s.scope === "journeys");
              if (journeySel?.items) {
                for (const sub of deps.subJourneys) {
                  if (!journeySel.items.includes(sub)) {
                    journeySel.items.push(sub);
                    emit({ type: "stdout", data: `  + Sub-journey: ${sub}\n`, ts: Date.now() });
                  }
                }
              }
            }

            // Add scripts to scopeSelections
            if (deps.scriptUuids.length > 0) {
              let scriptSel = scopeSelections.find((s) => s.scope === "scripts");
              if (!scriptSel) {
                scriptSel = { scope: "scripts" as any, items: [] };
                scopeSelections.push(scriptSel);
              }
              if (!scriptSel.items) scriptSel.items = [];
              for (const uuid of deps.scriptUuids) {
                const configFile = uuid + ".json";
                if (!scriptSel.items.includes(configFile)) {
                  const name = deps.scriptNames.get(uuid) ?? uuid;
                  scriptSel.items.push(configFile);
                  emit({ type: "stdout", data: `  + Script: ${name}\n`, ts: Date.now() });
                }
              }
            }

            emit({ type: "stdout", data: `  Total: ${deps.subJourneys.length} sub-journeys, ${deps.scriptUuids.length} scripts\n`, ts: Date.now() });
            emit({ type: "scope-end", scope: "resolve-deps", code: 0, ts: Date.now() });
          }
        }

        // Step 1: Copy only selected items from source to temp
        emit({ type: "scope-start", scope: "prepare", ts: Date.now() });
        emit({ type: "stdout", data: "Creating temporary copy of selected items...\n", ts: Date.now() });

        for (const sel of scopeSelections) {
          const sourceDirs = resolveScopeDirs(sourceConfigDir, sel.scope);
          for (const srcDir of sourceDirs) {
            const relPath = stagingRelPath(sourceConfigDir, srcDir, sel.scope);
            const destDir = path.join(tempConfigDir, relPath);

            if (!sel.items || sel.items.length === 0) {
              // No item filter — copy entire scope
              copyDirSync(srcDir, destDir);
              emit({ type: "stdout", data: `  Copied ${sel.scope}: ${relPath} (all)\n`, ts: Date.now() });
            } else if (sel.scope === "managed-objects") {
              // Vendored push merges the selected object into target's current
              // managed config at the REST level (GET → splice → PUT), so we
              // only need to stage the source's selected dirs.
              fs.mkdirSync(destDir, { recursive: true });
              for (const itemId of sel.items) {
                const srcItem = path.join(srcDir, itemId);
                const destItem = path.join(destDir, itemId);
                if (fs.existsSync(srcItem) && fs.statSync(srcItem).isDirectory()) {
                  copyDirSync(srcItem, destItem);
                }
              }
              emit({ type: "stdout", data: `  Copied ${sel.items.length} managed-object(s) from source\n`, ts: Date.now() });
            } else if (sel.scope === "scripts") {
              // Scripts: items are filenames in scripts-config (e.g., "uuid.json")
              // Copy matching scripts-config files + their scripts-content
              fs.mkdirSync(destDir, { recursive: true });
              const configSrc = path.join(srcDir, "scripts-config");
              const configDest = path.join(destDir, "scripts-config");
              if (fs.existsSync(configSrc)) {
                fs.mkdirSync(configDest, { recursive: true });
                for (const itemId of sel.items) {
                  const configFile = itemId.endsWith(".json") ? itemId : `${itemId}.json`;
                  const srcFile = path.join(configSrc, configFile);
                  if (fs.existsSync(srcFile)) {
                    fs.copyFileSync(srcFile, path.join(configDest, configFile));
                    // Read the config to find the script content file
                    try {
                      const config = JSON.parse(fs.readFileSync(srcFile, "utf-8"));
                      if (config.script?.file) {
                        const contentSrc = path.join(srcDir, config.script.file);
                        const contentDest = path.join(destDir, config.script.file);
                        if (fs.existsSync(contentSrc)) {
                          fs.mkdirSync(path.dirname(contentDest), { recursive: true });
                          fs.copyFileSync(contentSrc, contentDest);
                        }
                      }
                    } catch { /* skip */ }
                  }
                }
              }
              emit({ type: "stdout", data: `  Copied ${sel.scope}: ${sel.items.length} items\n`, ts: Date.now() });
            } else {
              // Generic scopes: items are directory names or filenames
              fs.mkdirSync(destDir, { recursive: true });
              for (const itemId of sel.items) {
                const srcItem = path.join(srcDir, itemId);
                const destItem = path.join(destDir, itemId);
                if (fs.existsSync(srcItem)) {
                  if (fs.statSync(srcItem).isDirectory()) {
                    copyDirSync(srcItem, destItem);
                  } else {
                    fs.copyFileSync(srcItem, destItem);
                  }
                }
                // Also try with .json extension
                const srcJson = srcItem + ".json";
                if (!fs.existsSync(srcItem) && fs.existsSync(srcJson)) {
                  fs.copyFileSync(srcJson, destItem + ".json");
                }
              }
              emit({ type: "stdout", data: `  Copied ${sel.scope}: ${sel.items.length} items\n`, ts: Date.now() });
            }
          }
        }

        // Step 1b: Copy referenced sub-journeys and scripts so the push step
        // can resolve InnerTreeEvaluatorNode / ScriptedDecisionNode references.
        // Without this, push fails with ENOENT when reading the inner journey
        // file. These are copied from source even if includeDeps is false —
        // they'll be pushed to target, but that's required for referential
        // integrity.
        {
          const journeyScope = scopeSelections.find(
            (s) => s.scope === "journeys" && s.items && s.items.length > 0
          );
          if (journeyScope?.items) {
            const deps = resolveJourneyDeps(sourceConfigDir, journeyScope.items);

            // Copy referenced sub-journey directories from source to temp
            for (const subName of deps.subJourneys) {
              if (journeyScope.items.includes(subName)) continue; // already copied
              for (const srcDir of resolveScopeDirs(sourceConfigDir, "journeys")) {
                const relPath = stagingRelPath(sourceConfigDir, srcDir, "journeys");
                const srcSub = path.join(srcDir, subName);
                const destSub = path.join(tempConfigDir, relPath, subName);
                if (fs.existsSync(srcSub)) {
                  copyDirSync(srcSub, destSub);
                  emit({ type: "stdout", data: `  Copied referenced sub-journey: ${subName}\n`, ts: Date.now() });
                  break;
                }
              }
            }

            // Copy referenced scripts (config + content) from source to temp
            if (deps.scriptUuids.length > 0) {
              const scriptScope = scopeSelections.find((s) => s.scope === "scripts");
              const existingScriptItems = new Set(scriptScope?.items ?? []);
              for (const srcDir of resolveScopeDirs(sourceConfigDir, "scripts")) {
                const relPath = stagingRelPath(sourceConfigDir, srcDir, "scripts");
                const configSrc = path.join(srcDir, "scripts-config");
                if (!fs.existsSync(configSrc)) continue;
                const configDest = path.join(tempConfigDir, relPath, "scripts-config");
                fs.mkdirSync(configDest, { recursive: true });

                for (const uuid of deps.scriptUuids) {
                  const configFile = `${uuid}.json`;
                  if (existingScriptItems.has(configFile)) continue; // already copied
                  const srcFile = path.join(configSrc, configFile);
                  if (!fs.existsSync(srcFile)) continue;
                  fs.copyFileSync(srcFile, path.join(configDest, configFile));
                  // Copy the script content file too
                  try {
                    const config = JSON.parse(fs.readFileSync(srcFile, "utf-8"));
                    if (config.script?.file) {
                      const contentSrc = path.join(srcDir, config.script.file);
                      const contentDest = path.join(tempConfigDir, relPath, config.script.file);
                      if (fs.existsSync(contentSrc)) {
                        fs.mkdirSync(path.dirname(contentDest), { recursive: true });
                        fs.copyFileSync(contentSrc, contentDest);
                      }
                    }
                  } catch { /* skip */ }
                  const scriptName = deps.scriptNames.get(uuid) ?? uuid;
                  emit({ type: "stdout", data: `  Copied referenced script: ${scriptName}\n`, ts: Date.now() });
                }
              }
            }
          }
        }

        // Step 2: For each scope, build name→id maps from source and target, then remap
        emit({ type: "scope-end", scope: "prepare", code: 0, ts: Date.now() });
        emit({ type: "scope-start", scope: "remap-ids", ts: Date.now() });
        emit({ type: "stdout", data: "Remapping IDs to match target environment...\n", ts: Date.now() });

        const remapLogs: string[] = [];
        for (const sel of scopeSelections) {
          const sourceDirs = resolveScopeDirs(sourceConfigDir, sel.scope);
          const targetDirs = resolveScopeDirs(targetConfigDir, sel.scope);
          const tempDirs = resolveScopeDirs(tempConfigDir, sel.scope);

          if (tempDirs.length === 0) continue;

          const sourceNameToId = buildNameToIdMap(sourceDirs, sel.scope);
          const targetNameToId = buildNameToIdMap(targetDirs, sel.scope);

          remapIds(tempDirs, sel.scope, sourceNameToId, targetNameToId, remapLogs);
        }

        for (const log of remapLogs) {
          emit({ type: "stdout", data: `  ${log}\n`, ts: Date.now() });
        }
        emit({ type: "scope-end", scope: "remap-ids", code: 0, ts: Date.now() });

        // Step 2b: Remap script UUID references inside journey node configs.
        // Always remap regardless of includeDeps — the journey nodes reference
        // scripts by UUID, and those UUIDs may differ between source and target.
        {
          const sourceScriptNameToUuid = new Map<string, string>();
          const targetScriptNameToUuid = new Map<string, string>();
          for (const dir of resolveScopeDirs(sourceConfigDir, "scripts")) {
            const cfgDir = path.join(dir, "scripts-config");
            if (!fs.existsSync(cfgDir)) continue;
            for (const f of fs.readdirSync(cfgDir)) {
              if (!f.endsWith(".json")) continue;
              try { const j = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf-8")); if (j.name && j._id) sourceScriptNameToUuid.set(j.name, j._id); } catch {}
            }
          }
          for (const dir of resolveScopeDirs(targetConfigDir!, "scripts")) {
            const cfgDir = path.join(dir, "scripts-config");
            if (!fs.existsSync(cfgDir)) continue;
            for (const f of fs.readdirSync(cfgDir)) {
              if (!f.endsWith(".json")) continue;
              try { const j = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf-8")); if (j.name && j._id) targetScriptNameToUuid.set(j.name, j._id); } catch {}
            }
          }

          // Build source UUID → target UUID via name
          const scriptUuidRemap = new Map<string, string>();
          for (const [name, sourceUuid] of sourceScriptNameToUuid) {
            const targetUuid = targetScriptNameToUuid.get(name);
            if (targetUuid && targetUuid !== sourceUuid) {
              scriptUuidRemap.set(sourceUuid, targetUuid);
            }
          }

          if (scriptUuidRemap.size > 0) {
            emit({ type: "scope-start", scope: "remap-script-refs", ts: Date.now() });
            emit({ type: "stdout", data: `Remapping ${scriptUuidRemap.size} script references in journey nodes...\n`, ts: Date.now() });

            for (const dir of resolveScopeDirs(tempConfigDir, "journeys")) {
              // Walk all journey node files in temp
              for (const journeyName of fs.readdirSync(dir)) {
                const nodesDir = path.join(dir, journeyName, "nodes");
                if (!fs.existsSync(nodesDir)) continue;
                for (const nf of fs.readdirSync(nodesDir)) {
                  const fp = path.join(nodesDir, nf);
                  if (fs.statSync(fp).isDirectory()) continue;
                  try {
                    const nd = JSON.parse(fs.readFileSync(fp, "utf-8"));
                    if (nd.script && scriptUuidRemap.has(nd.script)) {
                      const oldUuid = nd.script;
                      nd.script = scriptUuidRemap.get(oldUuid)!;
                      fs.writeFileSync(fp, JSON.stringify(nd, null, 2));
                      const scriptName = sourceScriptNameToUuid.has(oldUuid)
                        ? [...sourceScriptNameToUuid.entries()].find(([, v]) => v === oldUuid)?.[0] ?? oldUuid
                        : oldUuid;
                      emit({ type: "stdout", data: `  ${journeyName} → ${scriptName}: ${oldUuid} → ${nd.script}\n`, ts: Date.now() });
                    }
                  } catch { /* skip */ }
                }
              }
            }

            emit({ type: "scope-end", scope: "remap-script-refs", code: 0, ts: Date.now() });
          }
        }

        // Step 3: Push from temp dir to target environment

        // Only push scopes that actually have files in the temp dir
        const hasFiles = (dir: string): boolean => {
          if (!fs.existsSync(dir)) return false;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isFile()) return true;
            if (e.isDirectory() && hasFiles(path.join(dir, e.name))) return true;
          }
          return false;
        };
        const pushScopes = scopeSelections
          .map((s) => s.scope)
          .filter((scope) => {
            const dirs = resolveScopeDirs(tempConfigDir, scope);
            return dirs.some(hasFiles);
          });

        if (pushScopes.length === 0) {
          emit({ type: "stdout", data: "No items to push — temp directory is empty.\n", ts: Date.now() });
          emit({ type: "exit", code: 0, ts: Date.now() });
          controller.close();
          return;
        }

        // ── Push ──────────────────────────────────────────────────────────
        emit({ type: "scope-start", scope: "push", ts: Date.now() });

        // Route managed-objects + scripts through vendored push functions.
        // Everything else stays on fr-config-push spawn.
        const managedSel = scopeSelections.find(
          (s) => s.scope === "managed-objects" && s.items && s.items.length > 0,
        );
        const scriptsSel = scopeSelections.find(
          (s) => s.scope === "scripts" && s.items && s.items.length > 0,
        );
        const journeysSel = scopeSelections.find(
          (s) => s.scope === "journeys" && s.items && s.items.length > 0,
        );
        const idmFlatSels = scopeSelections.filter((s) => isIdmFlatScope(s.scope));
        const passwordPolicySel = scopeSelections.find((s) => s.scope === "password-policy");
        const orgPrivilegesSel = scopeSelections.find((s) => s.scope === "org-privileges");
        const cookieDomainsSel = scopeSelections.find((s) => s.scope === "cookie-domains");
        const corsSel = scopeSelections.find((s) => s.scope === "cors");
        const cspSel = scopeSelections.find((s) => s.scope === "csp");
        const localesSel = scopeSelections.find((s) => s.scope === "locales");
        const endpointsSel = scopeSelections.find((s) => s.scope === "endpoints");
        const internalRolesSel = scopeSelections.find((s) => s.scope === "internal-roles");
        const emailTemplatesSel = scopeSelections.find((s) => s.scope === "email-templates");
        const customNodesSel = scopeSelections.find((s) => s.scope === "custom-nodes");
        const themesSel = scopeSelections.find((s) => s.scope === "themes");
        const emailProviderSel = scopeSelections.find((s) => s.scope === "email-provider");
        const schedulesSel = scopeSelections.find((s) => s.scope === "schedules");
        const igaWorkflowsSel = scopeSelections.find((s) => s.scope === "iga-workflows");
        const termsSel = scopeSelections.find((s) => s.scope === "terms-and-conditions");
        const serviceObjectsSel = scopeSelections.find((s) => s.scope === "service-objects");
        // "raw" isn't in ConfigScope, so this comparison is currently always false
        // by the type system. Kept for future alignment if the type is extended.
        const rawSel = scopeSelections.find((s) => (s.scope as string) === "raw");
        const authzPoliciesSel = scopeSelections.find((s) => s.scope === "authz-policies");
        const oauth2AgentsSel = scopeSelections.find((s) => s.scope === "oauth2-agents");
        const servicesSel = scopeSelections.find((s) => s.scope === "services");
        const telemetrySel = scopeSelections.find((s) => s.scope === "telemetry");
        const connectorDefsSel = scopeSelections.find((s) => s.scope === "connector-definitions");
        const connectorMappingsSel = scopeSelections.find((s) => s.scope === "connector-mappings");
        const remoteServersSel = scopeSelections.find((s) => s.scope === "remote-servers");
        const secretsSel = scopeSelections.find((s) => s.scope === "secrets");
        const secretMappingsSel = scopeSelections.find((s) => s.scope === "secret-mappings");

        const targetEnvVarsForPush = parseEnvFile(getEnvFileContent(targetEnvironment));
        const tenantUrlForPush = targetEnvVarsForPush.TENANT_BASE_URL ?? "";
        let pushToken: string | null = null;
        const ensurePushToken = async (): Promise<string | null> => {
          if (pushToken) return pushToken;
          if (!tenantUrlForPush) {
            emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment}.\n`, ts: Date.now() });
            return null;
          }
          try {
            pushToken = await getAccessToken(targetEnvVarsForPush);
            return pushToken;
          } catch (err) {
            emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
            return null;
          }
        };

        let managedPushFailed = false;
        if (managedSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            managedPushFailed = true;
          } else {
            for (const itemId of managedSel.items!) {
              emit({ type: "stdout", data: `  Pushing managed-objects "${itemId}" (vendored)...\n`, ts: Date.now() });
              try {
                await pushManagedObjects({
                  configDir: tempConfigDir,
                  tenantUrl: tenantUrlForPush,
                  token,
                  name: itemId,
                  log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }),
                });
              } catch (err) {
                managedPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for "${itemId}": ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let scriptsPushFailed = false;
        if (scriptsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            scriptsPushFailed = true;
          } else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            // Build uuid → script-name lookup from temp dir so per-name push works.
            const uuidToScriptName = new Map<string, string>();
            for (const dir of resolveScopeDirs(tempConfigDir, "scripts")) {
              const cfgDir = path.join(dir, "scripts-config");
              if (!fs.existsSync(cfgDir)) continue;
              for (const f of fs.readdirSync(cfgDir)) {
                if (!f.endsWith(".json")) continue;
                try {
                  const json = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf-8"));
                  if (json.name) uuidToScriptName.set(path.basename(f, ".json"), json.name);
                } catch { /* skip */ }
              }
            }
            for (const itemId of scriptsSel.items!) {
              const baseId = itemId.replace(/\.json$/, "");
              const scriptName = uuidToScriptName.get(baseId) ?? baseId;
              emit({ type: "stdout", data: `  Pushing script "${scriptName}" (vendored)...\n`, ts: Date.now() });
              try {
                await pushScripts({
                  configDir: tempConfigDir,
                  tenantUrl: tenantUrlForPush,
                  token,
                  realms,
                  name: scriptName,
                  log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }),
                });
              } catch (err) {
                scriptsPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for "${scriptName}": ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let journeysPushFailed = false;
        if (journeysSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            journeysPushFailed = true;
          } else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            for (const itemId of journeysSel.items!) {
              emit({ type: "stdout", data: `  Pushing journey "${itemId}" (vendored)...\n`, ts: Date.now() });
              try {
                await pushJourneys({
                  configDir: tempConfigDir,
                  tenantUrl: tenantUrlForPush,
                  token,
                  realms,
                  name: itemId,
                  pushInnerJourneys: includeDeps === true,
                  pushScripts: false,
                  log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }),
                });
              } catch (err) {
                journeysPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for journey "${itemId}": ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let idmFlatPushFailed = false;
        if (idmFlatSels.length > 0 && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            idmFlatPushFailed = true;
          } else {
            for (const sel of idmFlatSels) {
              if (!isIdmFlatScope(sel.scope)) continue;
              emit({ type: "stdout", data: `  Pushing ${sel.scope} (vendored)...\n`, ts: Date.now() });
              try {
                await pushIdmFlatScope({
                  scope: sel.scope,
                  configDir: tempConfigDir,
                  tenantUrl: tenantUrlForPush,
                  token,
                  log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }),
                });
              } catch (err) {
                idmFlatPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for ${sel.scope}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let passwordPolicyPushFailed = false;
        if (passwordPolicySel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            passwordPolicyPushFailed = true;
          } else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            emit({ type: "stdout", data: `  Pushing password-policy (vendored)...\n`, ts: Date.now() });
            try {
              await pushPasswordPolicy({
                configDir: tempConfigDir,
                tenantUrl: tenantUrlForPush,
                token,
                realms,
                log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }),
              });
            } catch (err) {
              passwordPolicyPushFailed = true;
              emit({ type: "stderr", data: `  Push failed for password-policy: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
            }
          }
        }

        let orgPrivilegesPushFailed = false;
        if (orgPrivilegesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            orgPrivilegesPushFailed = true;
          } else {
            const items = orgPrivilegesSel.items && orgPrivilegesSel.items.length > 0 ? orgPrivilegesSel.items : [undefined];
            for (const itemId of items) {
              emit({ type: "stdout", data: `  Pushing org-privileges${itemId ? ` "${itemId}"` : ""} (vendored)...\n`, ts: Date.now() });
              try {
                await pushOrgPrivileges({
                  configDir: tempConfigDir,
                  tenantUrl: tenantUrlForPush,
                  token,
                  name: itemId,
                  log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }),
                });
              } catch (err) {
                orgPrivilegesPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for org-privileges${itemId ? ` "${itemId}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let cookieDomainsPushFailed = false;
        if (cookieDomainsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            cookieDomainsPushFailed = true;
          } else {
            emit({ type: "stdout", data: `  Pushing cookie-domains (vendored)...\n`, ts: Date.now() });
            try {
              await pushCookieDomains({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
            } catch (err) {
              cookieDomainsPushFailed = true;
              emit({ type: "stderr", data: `  Push failed for cookie-domains: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
            }
          }
        }

        let corsPushFailed = false;
        if (corsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            corsPushFailed = true;
          } else {
            emit({ type: "stdout", data: `  Pushing cors (vendored)...\n`, ts: Date.now() });
            try {
              await pushCors({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
            } catch (err) {
              corsPushFailed = true;
              emit({ type: "stderr", data: `  Push failed for cors: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
            }
          }
        }

        let cspPushFailed = false;
        if (cspSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            cspPushFailed = true;
          } else {
            const items = cspSel.items && cspSel.items.length > 0 ? cspSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing csp${name ? ` "${name}"` : ""} (vendored)...\n`, ts: Date.now() });
              try {
                await pushCsp({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
              } catch (err) {
                cspPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for csp${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let localesPushFailed = false;
        if (localesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            localesPushFailed = true;
          } else {
            const items = localesSel.items && localesSel.items.length > 0 ? localesSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing locale${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try {
                await pushLocales({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
              } catch (err) {
                localesPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for locales${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let endpointsPushFailed = false;
        if (endpointsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            endpointsPushFailed = true;
          } else {
            const items = endpointsSel.items && endpointsSel.items.length > 0 ? endpointsSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing endpoint${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try {
                await pushEndpoints({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
              } catch (err) {
                endpointsPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for endpoints${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let internalRolesPushFailed = false;
        if (internalRolesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) {
            internalRolesPushFailed = true;
          } else {
            const items = internalRolesSel.items && internalRolesSel.items.length > 0 ? internalRolesSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing internal-role${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try {
                await pushInternalRoles({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
              } catch (err) {
                internalRolesPushFailed = true;
                emit({ type: "stderr", data: `  Push failed for internal-roles${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
              }
            }
          }
        }

        let emailTemplatesPushFailed = false;
        if (emailTemplatesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { emailTemplatesPushFailed = true; }
          else {
            const items = emailTemplatesSel.items && emailTemplatesSel.items.length > 0 ? emailTemplatesSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing email-template${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushEmailTemplates({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { emailTemplatesPushFailed = true; emit({ type: "stderr", data: `  Push failed for email-templates${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let customNodesPushFailed = false;
        if (customNodesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { customNodesPushFailed = true; }
          else {
            const items = customNodesSel.items && customNodesSel.items.length > 0 ? customNodesSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing custom-node${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushCustomNodes({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { customNodesPushFailed = true; emit({ type: "stderr", data: `  Push failed for custom-nodes${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let themesPushFailed = false;
        if (themesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { themesPushFailed = true; }
          else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            const items = themesSel.items && themesSel.items.length > 0 ? themesSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing theme${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushThemes({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, realms, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { themesPushFailed = true; emit({ type: "stderr", data: `  Push failed for themes${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let emailProviderPushFailed = false;
        if (emailProviderSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { emailProviderPushFailed = true; }
          else {
            emit({ type: "stdout", data: `  Pushing email-provider (vendored)...\n`, ts: Date.now() });
            try { await pushEmailProvider({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
            catch (err) { emailProviderPushFailed = true; emit({ type: "stderr", data: `  Push failed for email-provider: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
          }
        }

        let schedulesPushFailed = false;
        if (schedulesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { schedulesPushFailed = true; }
          else {
            const items = schedulesSel.items && schedulesSel.items.length > 0 ? schedulesSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing schedule${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushSchedules({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { schedulesPushFailed = true; emit({ type: "stderr", data: `  Push failed for schedules${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let igaWorkflowsPushFailed = false;
        if (igaWorkflowsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { igaWorkflowsPushFailed = true; }
          else {
            const items = igaWorkflowsSel.items && igaWorkflowsSel.items.length > 0 ? igaWorkflowsSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing iga-workflow${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushIgaWorkflows({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { igaWorkflowsPushFailed = true; emit({ type: "stderr", data: `  Push failed for iga-workflows${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let termsPushFailed = false;
        if (termsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { termsPushFailed = true; }
          else {
            emit({ type: "stdout", data: `  Pushing terms-and-conditions (vendored)...\n`, ts: Date.now() });
            try { await pushTermsAndConditions({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
            catch (err) { termsPushFailed = true; emit({ type: "stderr", data: `  Push failed for terms-and-conditions: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
          }
        }

        let serviceObjectsPushFailed = false;
        if (serviceObjectsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { serviceObjectsPushFailed = true; }
          else {
            emit({ type: "stdout", data: `  Pushing service-objects (vendored)...\n`, ts: Date.now() });
            try { await pushServiceObjects({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, envVars: targetEnvVarsForPush, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
            catch (err) { serviceObjectsPushFailed = true; emit({ type: "stderr", data: `  Push failed for service-objects: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
          }
        }

        let rawPushFailed = false;
        if (rawSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { rawPushFailed = true; }
          else {
            const items = rawSel.items && rawSel.items.length > 0 ? rawSel.items : [undefined];
            for (const requestedPath of items) {
              emit({ type: "stdout", data: `  Pushing raw${requestedPath ? ` ${requestedPath}` : ""} (vendored)...\n`, ts: Date.now() });
              try { await pushRawConfig({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, requestedPath, envVars: targetEnvVarsForPush, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { rawPushFailed = true; emit({ type: "stderr", data: `  Push failed for raw${requestedPath ? ` ${requestedPath}` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let authzPoliciesPushFailed = false;
        if (authzPoliciesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { authzPoliciesPushFailed = true; }
          else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            emit({ type: "stdout", data: `  Pushing authz-policies (vendored)...\n`, ts: Date.now() });
            try { await pushAuthzPolicies({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, realms, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
            catch (err) { authzPoliciesPushFailed = true; emit({ type: "stderr", data: `  Push failed for authz-policies: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
          }
        }

        let oauth2AgentsPushFailed = false;
        if (oauth2AgentsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { oauth2AgentsPushFailed = true; }
          else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            emit({ type: "stdout", data: `  Pushing oauth2-agents (vendored)...\n`, ts: Date.now() });
            try { await pushOauth2Agents({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, realms, envVars: targetEnvVarsForPush, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
            catch (err) { oauth2AgentsPushFailed = true; emit({ type: "stderr", data: `  Push failed for oauth2-agents: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
          }
        }

        let servicesPushFailed = false;
        if (servicesSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { servicesPushFailed = true; }
          else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            const items = servicesSel.items && servicesSel.items.length > 0 ? servicesSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing service${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushServices({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, realms, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { servicesPushFailed = true; emit({ type: "stderr", data: `  Push failed for services${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let telemetryPushFailed = false;
        if (telemetrySel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { telemetryPushFailed = true; }
          else {
            const items = telemetrySel.items && telemetrySel.items.length > 0 ? telemetrySel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing telemetry${name ? ` "${name}"` : ""} (vendored)...\n`, ts: Date.now() });
              try { await pushTelemetry({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, envVars: targetEnvVarsForPush, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { telemetryPushFailed = true; emit({ type: "stderr", data: `  Push failed for telemetry${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let connectorDefsPushFailed = false;
        if (connectorDefsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { connectorDefsPushFailed = true; }
          else {
            const items = connectorDefsSel.items && connectorDefsSel.items.length > 0 ? connectorDefsSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing connector-definition${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushConnectorDefinitions({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { connectorDefsPushFailed = true; emit({ type: "stderr", data: `  Push failed for connector-definitions${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let connectorMappingsPushFailed = false;
        if (connectorMappingsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { connectorMappingsPushFailed = true; }
          else {
            const items = connectorMappingsSel.items && connectorMappingsSel.items.length > 0 ? connectorMappingsSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing connector-mapping${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushConnectorMappings({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { connectorMappingsPushFailed = true; emit({ type: "stderr", data: `  Push failed for connector-mappings${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let remoteServersPushFailed = false;
        if (remoteServersSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { remoteServersPushFailed = true; }
          else {
            emit({ type: "stdout", data: `  Pushing remote-servers (vendored)...\n`, ts: Date.now() });
            try { await pushRemoteServers({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
            catch (err) { remoteServersPushFailed = true; emit({ type: "stderr", data: `  Push failed for remote-servers: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
          }
        }

        let secretsPushFailed = false;
        if (secretsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { secretsPushFailed = true; }
          else {
            const items = secretsSel.items && secretsSel.items.length > 0 ? secretsSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing secret${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushSecrets({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, name, envVars: targetEnvVarsForPush, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { secretsPushFailed = true; emit({ type: "stderr", data: `  Push failed for secrets${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        let secretMappingsPushFailed = false;
        if (secretMappingsSel && !directControl) {
          const token = await ensurePushToken();
          if (!token) { secretMappingsPushFailed = true; }
          else {
            const realms = targetEnvVarsForPush.REALMS ? (JSON.parse(targetEnvVarsForPush.REALMS) as string[]) : ["alpha"];
            const items = secretMappingsSel.items && secretMappingsSel.items.length > 0 ? secretMappingsSel.items : [undefined];
            for (const name of items) {
              emit({ type: "stdout", data: `  Pushing secret-mapping${name ? ` "${name}"` : "s"} (vendored)...\n`, ts: Date.now() });
              try { await pushSecretMappings({ configDir: tempConfigDir, tenantUrl: tenantUrlForPush, token, realms, name, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) }); }
              catch (err) { secretMappingsPushFailed = true; emit({ type: "stderr", data: `  Push failed for secret-mappings${name ? ` "${name}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
            }
          }
        }

        // Remove vendor-handled scopes from the spawn set.
        const spawnPushScopes = pushScopes.filter((s) => {
          if (directControl) return true;
          if (managedSel && s === "managed-objects") return false;
          if (scriptsSel && s === "scripts") return false;
          if (journeysSel && s === "journeys") return false;
          if (isIdmFlatScope(s)) return false;
          if (passwordPolicySel && s === "password-policy") return false;
          if (orgPrivilegesSel && s === "org-privileges") return false;
          if (cookieDomainsSel && s === "cookie-domains") return false;
          if (corsSel && s === "cors") return false;
          if (cspSel && s === "csp") return false;
          if (localesSel && s === "locales") return false;
          if (endpointsSel && s === "endpoints") return false;
          if (internalRolesSel && s === "internal-roles") return false;
          if (emailTemplatesSel && s === "email-templates") return false;
          if (customNodesSel && s === "custom-nodes") return false;
          if (themesSel && s === "themes") return false;
          if (emailProviderSel && s === "email-provider") return false;
          if (schedulesSel && s === "schedules") return false;
          if (igaWorkflowsSel && s === "iga-workflows") return false;
          if (termsSel && s === "terms-and-conditions") return false;
          if (serviceObjectsSel && s === "service-objects") return false;
          if (rawSel && (s as string) === "raw") return false;
          if (authzPoliciesSel && s === "authz-policies") return false;
          if (oauth2AgentsSel && s === "oauth2-agents") return false;
          if (servicesSel && s === "services") return false;
          if (telemetrySel && s === "telemetry") return false;
          if (connectorDefsSel && s === "connector-definitions") return false;
          if (connectorMappingsSel && s === "connector-mappings") return false;
          if (remoteServersSel && s === "remote-servers") return false;
          if (secretsSel && s === "secrets") return false;
          if (secretMappingsSel && s === "secret-mappings") return false;
          return true;
        });

        // Push dependencies before dependents. Scripts (and other "leaf"
        // resources) must reach the tenant before journeys, otherwise the
        // journey/node PUT references script UUIDs the tenant doesn't know
        // yet and AIC returns 400. The non-DCC path enforces this implicitly
        // via the per-scope blocks above (scriptsSel block runs before
        // journeysSel block), but the DCC path falls through to spawnFrConfig
        // with whatever order scopeSelections happens to be in. Sort here.
        const SCOPE_PUSH_RANK: Record<string, number> = {
          // Leaf resources first (no inbound deps from other selected scopes).
          "scripts": 10,
          "managed-objects": 20,
          // Anything not listed lands in the middle (rank 50).
          // Dependents last.
          "journeys": 90,
        };
        spawnPushScopes.sort((a, b) =>
          (SCOPE_PUSH_RANK[a as string] ?? 50) - (SCOPE_PUSH_RANK[b as string] ?? 50)
        );

        let pushFailed = managedPushFailed || scriptsPushFailed || journeysPushFailed || idmFlatPushFailed || passwordPolicyPushFailed || orgPrivilegesPushFailed || cookieDomainsPushFailed || corsPushFailed || cspPushFailed || localesPushFailed || endpointsPushFailed || internalRolesPushFailed || emailTemplatesPushFailed || customNodesPushFailed || themesPushFailed || emailProviderPushFailed || schedulesPushFailed || igaWorkflowsPushFailed || termsPushFailed || serviceObjectsPushFailed || rawPushFailed || authzPoliciesPushFailed || oauth2AgentsPushFailed || servicesPushFailed || telemetryPushFailed || connectorDefsPushFailed || connectorMappingsPushFailed || remoteServersPushFailed || secretsPushFailed || secretMappingsPushFailed;

        if (spawnPushScopes.length > 0) {
          // Note: --direct-control adds an X-Configuration-Type: mutable
          // request header (per upstream restClient v1.5.12); URLs are
          // unchanged. Phrase the banner accordingly.
          emit({ type: "stdout", data: `Pushing ${spawnPushScopes.length} scope(s) via fr-config-push: ${spawnPushScopes.join(", ")}${directControl ? " (X-Configuration-Type: mutable)" : ""}...\n`, ts: Date.now() });
          const { stream: pushStream } = spawnFrConfig({
            command: "fr-config-push",
            environment: targetEnvironment,
            scopes: spawnPushScopes as import("@/lib/fr-config-types").ConfigScope[],
            envOverrides: { CONFIG_DIR: tempConfigDir },
            ...(directControl ? { globalArgs: ["--direct-control"] } : {}),
          });

          const reader = pushStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of value.split("\n")) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === "exit") {
                  if (parsed.code !== 0) pushFailed = true;
                  continue;
                }
                if (parsed.type === "scope-start" || parsed.type === "scope-end") {
                  emit({ type: "stdout", data: `[${parsed.scope}] ${parsed.type === "scope-start" ? "started" : `finished (exit ${parsed.code})`}\n`, ts: Date.now() });
                  continue;
                }
                controller.enqueue(line + "\n");
              } catch {
                controller.enqueue(line + "\n");
              }
            }
          }
        }

        emit({ type: "scope-end", scope: "push", code: pushFailed ? 1 : 0, ts: Date.now() });

        // For controlled environments (--direct-control), defer pull-target
        // until after the DCC session has been applied on the tenant. Pulling
        // here would capture pre-apply state and cause spurious verify diffs.
        if (directControl) {
          if (pushFailed) {
            emit({ type: "exit", code: 1, ts: Date.now() });
          } else {
            emit({ type: "stdout", data: `Push staged in direct-control session. Pull-target deferred until after apply.\n`, ts: Date.now() });
            emit({ type: "exit", code: 0, ts: Date.now() });
          }
          controller.close();
          return;
        }

        // Step 4: Pull target to sync local files (only if push succeeded)
        if (!pushFailed) {
          emit({ type: "scope-start", scope: "pull-target", ts: Date.now() });
          emit({ type: "stdout", data: `Pulling pushed items from ${targetEnvironment} to sync local files...\n`, ts: Date.now() });

          // Resolve script items to names for --name flag (fr-config-pull uses --name, not filenameFilter)
          const uuidToName = new Map<string, string>();
          for (const dir of resolveScopeDirs(tempConfigDir, "scripts")) {
            const cfgDir = path.join(dir, "scripts-config");
            if (!fs.existsSync(cfgDir)) continue;
            for (const f of fs.readdirSync(cfgDir)) {
              if (!f.endsWith(".json")) continue;
              try {
                const json = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf-8"));
                if (json.name) {
                  uuidToName.set(path.basename(f, ".json"), json.name);
                  uuidToName.set(`name:${json.name}`, json.name);
                }
              } catch { /* skip */ }
            }
          }

          // Pull each scope/item using spawn directly (scripts need --name flag)
          const { spawn: spawnProc } = await import("child_process");
          const pullEnvVars = parseEnvFile(getEnvFileContent(targetEnvironment));
          const pullEnv = { ...process.env, ...pullEnvVars };
          const pullCwd = path.join(process.cwd(), "environments", targetEnvironment);

          for (const sel of scopeSelections) {
            if (sel.scope === "journeys" && sel.items && sel.items.length > 0) {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              const realms = pullEnvVars.REALMS ? (JSON.parse(pullEnvVars.REALMS) as string[]) : ["alpha"];
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping journeys pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) {
                  emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  for (const itemId of sel.items) {
                    emit({ type: "stdout", data: `  Pulling journey "${itemId}" (vendored)...\n`, ts: Date.now() });
                    try {
                      await pullJourneys({ exportDir, tenantUrl, token, realms, name: itemId, pullDependencies: includeDeps === true, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
                    } catch (err) {
                      emit({ type: "stderr", data: `  Pull failed for journey "${itemId}": ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                    }
                  }
                }
              }
            } else if (sel.scope === "scripts" && sel.items && sel.items.length > 0) {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              const realms = pullEnvVars.REALMS ? (JSON.parse(pullEnvVars.REALMS) as string[]) : ["alpha"];
              const prefixes = pullEnvVars.SCRIPT_PREFIXES ? (JSON.parse(pullEnvVars.SCRIPT_PREFIXES) as string[]) : [""];
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping scripts pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) {
                  emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  for (const itemId of sel.items) {
                    const scriptName = uuidToName.get(itemId) ?? uuidToName.get(itemId.replace(/\.json$/, "")) ?? itemId;
                    emit({ type: "stdout", data: `  Pulling script "${scriptName}" (vendored)...\n`, ts: Date.now() });
                    try {
                      await pullScripts({ exportDir, tenantUrl, token, realms, prefixes, name: scriptName, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
                    } catch (err) {
                      emit({ type: "stderr", data: `  Pull failed for "${scriptName}": ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                    }
                  }
                }
              }
            } else if (sel.items && sel.items.length > 0) {
              // fr-config-pull managed-objects --name has an upstream bug (managed.js:66
              // uses `return` instead of `continue`, aborting on the first non-matching
              // object). Pull the whole scope instead so all updated objects land on disk.
              if (sel.scope === "managed-objects") {
                const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
                if (!tenantUrl) {
                  emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping managed-objects pull.\n`, ts: Date.now() });
                  continue;
                }
                let token: string;
                try {
                  token = await getAccessToken(pullEnvVars);
                } catch (err) {
                  emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                  continue;
                }
                const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                const exportDir = path.resolve(pullCwd, configDirRel);
                for (const itemId of sel.items) {
                  emit({ type: "stdout", data: `  Pulling ${sel.scope} "${itemId}" (vendored)...\n`, ts: Date.now() });
                  try {
                    await pullManagedObjects({ exportDir, tenantUrl, token, name: itemId });
                  } catch (err) {
                    emit({ type: "stderr", data: `  Pull failed for "${itemId}": ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                  }
                }
                continue;
              }
              // Non-script scopes with item selection: dispatch in-process
              // (vendored functions). No CLI spawn.
              for (const itemId of sel.items) {
                emit({ type: "stdout", data: `  Pulling ${sel.scope} "${itemId}" (vendored)...\n`, ts: Date.now() });
                const result = await dispatchFrConfig({
                  command: "fr-config-pull",
                  scope: sel.scope,
                  envVars: pullEnvVars as Record<string, string | undefined>,
                  envDir: pullCwd,
                  extraArgs: ["--name", itemId],
                  extraEnv: {},
                  emit: (data, type) => emit({ type, data, ts: Date.now() }),
                });
                if (!result.handled) {
                  emit({ type: "stderr", data: `  Scope "${sel.scope}" has no vendored pull — not supported.\n`, ts: Date.now() });
                } else if ((result.code ?? 0) !== 0) {
                  emit({ type: "stderr", data: `  Pull failed for "${itemId}" (exit ${result.code})\n`, ts: Date.now() });
                }
              }
            } else if (isIdmFlatScope(sel.scope)) {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping ${sel.scope} pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  emit({ type: "stdout", data: `  Pulling ${sel.scope} (vendored)...\n`, ts: Date.now() });
                  try {
                    await pullIdmFlatScope({ scope: sel.scope, exportDir, tenantUrl, token, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
                  } catch (err) {
                    emit({ type: "stderr", data: `  Pull failed for ${sel.scope}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                  }
                }
              }
            } else if (sel.scope === "password-policy") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              const realms = pullEnvVars.REALMS ? (JSON.parse(pullEnvVars.REALMS) as string[]) : ["alpha"];
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping password-policy pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  emit({ type: "stdout", data: `  Pulling password-policy (vendored)...\n`, ts: Date.now() });
                  try {
                    await pullPasswordPolicy({ exportDir, tenantUrl, token, realms, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
                  } catch (err) {
                    emit({ type: "stderr", data: `  Pull failed for password-policy: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                  }
                }
              }
            } else if (sel.scope === "org-privileges") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping org-privileges pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  emit({ type: "stdout", data: `  Pulling org-privileges (vendored)...\n`, ts: Date.now() });
                  try {
                    await pullOrgPrivileges({ exportDir, tenantUrl, token, log: (line) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() }) });
                  } catch (err) {
                    emit({ type: "stderr", data: `  Pull failed for org-privileges: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                  }
                }
              }
            } else if (sel.scope === "telemetry" || sel.scope === "connector-definitions" || sel.scope === "connector-mappings" || sel.scope === "remote-servers" || sel.scope === "secrets" || sel.scope === "secret-mappings") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              const realms = pullEnvVars.REALMS ? (JSON.parse(pullEnvVars.REALMS) as string[]) : ["alpha"];
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping ${sel.scope} pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  const logLine = (line: string) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() });
                  const items = sel.items && sel.items.length > 0 ? sel.items : [undefined];
                  for (const itemId of items) {
                    emit({ type: "stdout", data: `  Pulling ${sel.scope}${itemId ? ` "${itemId}"` : ""} (vendored)...\n`, ts: Date.now() });
                    try {
                      if (sel.scope === "telemetry") {
                        await pullTelemetry({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "connector-definitions") {
                        await pullConnectorDefinitions({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "connector-mappings") {
                        await pullConnectorMappings({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "remote-servers") {
                        await pullRemoteServers({ exportDir, tenantUrl, token, log: logLine });
                      } else if (sel.scope === "secrets") {
                        await pullSecrets({ exportDir, tenantUrl, token, name: itemId, activeOnly: true, log: logLine });
                      } else if (sel.scope === "secret-mappings") {
                        await pullSecretMappings({ exportDir, tenantUrl, token, realms, name: itemId, log: logLine });
                      }
                    } catch (err) {
                      emit({ type: "stderr", data: `  Pull failed for ${sel.scope}${itemId ? ` "${itemId}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                    }
                  }
                }
              }
            } else if (sel.scope === "authz-policies" || sel.scope === "oauth2-agents" || sel.scope === "services") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              const realms = pullEnvVars.REALMS ? (JSON.parse(pullEnvVars.REALMS) as string[]) : ["alpha"];
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping ${sel.scope} pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  const logLine = (line: string) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() });
                  emit({ type: "stdout", data: `  Pulling ${sel.scope} (vendored)...\n`, ts: Date.now() });
                  try {
                    if (sel.scope === "authz-policies") {
                      const descriptorFile = pullEnvVars.POLICY_SETS_CONFIG_FILE ? path.resolve(pullCwd, pullEnvVars.POLICY_SETS_CONFIG_FILE) : undefined;
                      await pullAuthzPolicies({ exportDir, tenantUrl, token, descriptorFile, log: logLine });
                    } else if (sel.scope === "oauth2-agents") {
                      const descriptorFile = pullEnvVars.AGENTS_CONFIG_FILE ? path.resolve(pullCwd, pullEnvVars.AGENTS_CONFIG_FILE) : undefined;
                      await pullOauth2Agents({ exportDir, tenantUrl, token, descriptorFile, log: logLine });
                    } else {
                      const name = sel.items && sel.items.length === 1 ? sel.items[0] : undefined;
                      await pullServices({ exportDir, tenantUrl, token, realms, name, log: logLine });
                    }
                  } catch (err) {
                    emit({ type: "stderr", data: `  Pull failed for ${sel.scope}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                  }
                }
              }
            } else if (sel.scope === "email-provider" || sel.scope === "schedules" || sel.scope === "iga-workflows" || sel.scope === "terms-and-conditions" || sel.scope === "service-objects" || (sel.scope as string) === "raw") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping ${sel.scope} pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  const logLine = (line: string) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() });
                  const items = sel.items && sel.items.length > 0 ? sel.items : [undefined];
                  for (const itemId of items) {
                    emit({ type: "stdout", data: `  Pulling ${sel.scope}${itemId ? ` "${itemId}"` : ""} (vendored)...\n`, ts: Date.now() });
                    try {
                      if (sel.scope === "email-provider") {
                        await pullEmailProvider({ exportDir, tenantUrl, token, log: logLine });
                      } else if (sel.scope === "schedules") {
                        await pullSchedules({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "iga-workflows") {
                        await pullIgaWorkflows({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "terms-and-conditions") {
                        await pullTermsAndConditions({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "service-objects") {
                        // service-objects pull needs a descriptor file; skip gracefully if none.
                        const descriptorFile = pullEnvVars.SERVICE_OBJECTS_CONFIG_FILE ? path.resolve(pullCwd, pullEnvVars.SERVICE_OBJECTS_CONFIG_FILE) : undefined;
                        await pullServiceObjects({ exportDir, tenantUrl, token, descriptorFile, log: logLine });
                      } else if ((sel.scope as string) === "raw") {
                        const descriptorFile = pullEnvVars.RAW_CONFIG ? path.resolve(pullCwd, pullEnvVars.RAW_CONFIG) : undefined;
                        await pullRawConfig({ exportDir, tenantUrl, token, requestedPath: itemId, descriptorFile, log: logLine });
                      }
                    } catch (err) {
                      emit({ type: "stderr", data: `  Pull failed for ${sel.scope}${itemId ? ` "${itemId}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                    }
                  }
                }
              }
            } else if (sel.scope === "email-templates" || sel.scope === "custom-nodes" || sel.scope === "themes") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              const realms = pullEnvVars.REALMS ? (JSON.parse(pullEnvVars.REALMS) as string[]) : ["alpha"];
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping ${sel.scope} pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  const logLine = (line: string) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() });
                  const items = sel.items && sel.items.length > 0 ? sel.items : [undefined];
                  for (const itemId of items) {
                    emit({ type: "stdout", data: `  Pulling ${sel.scope}${itemId ? ` "${itemId}"` : ""} (vendored)...\n`, ts: Date.now() });
                    try {
                      if (sel.scope === "email-templates") {
                        await pullEmailTemplates({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "custom-nodes") {
                        await pullCustomNodes({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else if (sel.scope === "themes") {
                        await pullThemes({ exportDir, tenantUrl, token, realms, name: itemId, log: logLine });
                      }
                    } catch (err) {
                      emit({ type: "stderr", data: `  Pull failed for ${sel.scope}${itemId ? ` "${itemId}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                    }
                  }
                }
              }
            } else if (sel.scope === "endpoints" || sel.scope === "internal-roles") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping ${sel.scope} pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  const logLine = (line: string) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() });
                  const items = sel.items && sel.items.length > 0 ? sel.items : [undefined];
                  for (const itemId of items) {
                    emit({ type: "stdout", data: `  Pulling ${sel.scope}${itemId ? ` "${itemId}"` : ""} (vendored)...\n`, ts: Date.now() });
                    try {
                      if (sel.scope === "endpoints") {
                        await pullEndpoints({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      } else {
                        await pullInternalRoles({ exportDir, tenantUrl, token, name: itemId, log: logLine });
                      }
                    } catch (err) {
                      emit({ type: "stderr", data: `  Pull failed for ${sel.scope}${itemId ? ` "${itemId}"` : ""}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                    }
                  }
                }
              }
            } else if (sel.scope === "cookie-domains" || sel.scope === "cors" || sel.scope === "csp" || sel.scope === "locales") {
              const tenantUrl = pullEnvVars.TENANT_BASE_URL ?? "";
              if (!tenantUrl) {
                emit({ type: "stderr", data: `  TENANT_BASE_URL missing for ${targetEnvironment} — skipping ${sel.scope} pull.\n`, ts: Date.now() });
              } else {
                let token: string | null = null;
                try { token = await getAccessToken(pullEnvVars); }
                catch (err) { emit({ type: "stderr", data: `  Token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() }); }
                if (token) {
                  const configDirRel = pullEnvVars.CONFIG_DIR ?? "./config";
                  const exportDir = path.resolve(pullCwd, configDirRel);
                  const logLine = (line: string) => emit({ type: "stdout", data: `  ${line}`, ts: Date.now() });
                  emit({ type: "stdout", data: `  Pulling ${sel.scope} (vendored)...\n`, ts: Date.now() });
                  try {
                    if (sel.scope === "cookie-domains") {
                      await pullCookieDomains({ exportDir, tenantUrl, token, log: logLine });
                    } else if (sel.scope === "cors") {
                      await pullCors({ exportDir, tenantUrl, token, log: logLine });
                    } else if (sel.scope === "csp") {
                      const name = sel.items && sel.items.length === 1 ? sel.items[0] : undefined;
                      await pullCsp({ exportDir, tenantUrl, token, name, log: logLine });
                    } else if (sel.scope === "locales") {
                      const name = sel.items && sel.items.length === 1 ? sel.items[0] : undefined;
                      await pullLocales({ exportDir, tenantUrl, token, name, log: logLine });
                    }
                  } catch (err) {
                    emit({ type: "stderr", data: `  Pull failed for ${sel.scope}: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
                  }
                }
              }
            } else {
              // Entire scope: pull all — dispatch in-process (vendored).
              emit({ type: "stdout", data: `  Pulling ${sel.scope} (all, vendored)...\n`, ts: Date.now() });
              const result = await dispatchFrConfig({
                command: "fr-config-pull",
                scope: sel.scope,
                envVars: pullEnvVars as Record<string, string | undefined>,
                envDir: pullCwd,
                extraArgs: [],
                extraEnv: {},
                emit: (data, type) => emit({ type, data, ts: Date.now() }),
              });
              if (!result.handled) {
                emit({ type: "stderr", data: `  Scope "${sel.scope}" has no vendored pull — not supported.\n`, ts: Date.now() });
              } else if ((result.code ?? 0) !== 0) {
                emit({ type: "stderr", data: `  Pull failed for ${sel.scope} (exit ${result.code})\n`, ts: Date.now() });
              }
            }
          }

          emit({ type: "scope-end", scope: "pull-target", code: 0, ts: Date.now() });
          emit({ type: "stdout", data: "Local files synced with target.\n", ts: Date.now() });
        }

        emit({ type: "exit", code: pushFailed ? 1 : 0, ts: Date.now() });
      } catch (err) {
        emit({ type: "stderr", data: `Error: ${err instanceof Error ? err.message : String(err)}\n`, ts: Date.now() });
        emit({ type: "exit", code: 1, ts: Date.now() });
      } finally {
        // Cleanup temp directory
        try {
          if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch { /* ignore */ }
        controller.close();
      }
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
