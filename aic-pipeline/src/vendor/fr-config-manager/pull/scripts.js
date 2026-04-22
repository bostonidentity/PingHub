/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/scripts.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Accepts exportDir / tenantUrl / realms / prefixes / name / token as args
 *     instead of reading process.env. prefixes is an array, not a JSON string.
 *   - Throws on error instead of calling process.exit(1).
 *   - Drops the AuthzTypes constants import (unused in this function).
 *   - Drops the checkForDuplicates helper — logging only; not a fix, not safety.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const SCRIPT_SUB_DIR = "scripts";
const SCRIPTS_CONTENT_DIR = "scripts-content";
const SCRIPTS_CONFIG_DIR = "scripts-config";

function saveJsonToFile(data, filename) {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
}

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function saveScriptToFile(script, exportDir) {
  const scriptContentRelativePath = `${SCRIPTS_CONTENT_DIR}/${script.context}`;
  const scriptContentPath = path.join(exportDir, scriptContentRelativePath);
  if (!fs.existsSync(scriptContentPath)) fs.mkdirSync(scriptContentPath, { recursive: true });

  const scriptConfigPath = path.join(exportDir, SCRIPTS_CONFIG_DIR);
  if (!fs.existsSync(scriptConfigPath)) fs.mkdirSync(scriptConfigPath, { recursive: true });

  const scriptFilename = `${safeFileName(script.name)}.js`;
  const buff = Buffer.from(script.script, "base64");
  const source = buff.toString("utf-8");
  fs.writeFileSync(path.join(scriptContentPath, scriptFilename), source);
  script.script = { file: `${scriptContentRelativePath}/${scriptFilename}` };

  saveJsonToFile(script, path.join(scriptConfigPath, `${script._id}.json`));
}

function processScripts(scripts, exportDir, filters, emit) {
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

  // Track which filters have not yet matched anything (so we can emit a
  // "Script not found" line for each, instead of one for the whole batch).
  const unmatched = filters ? new Set(filters) : null;

  for (const script of scripts) {
    if (script.language !== "JAVASCRIPT") continue;
    if (filters) {
      // Match against either the script name or the AM `_id` (UUID).
      const anyMatch = filters.some((f) => f === script.name || f === script._id);
      if (!anyMatch) continue;
      // Callers can pass duplicate forms for the same script (e.g. compare's
      // addDepsToSelections pushes both `<uuid>.json` and `name:<n>`). Clear
      // *every* filter that points to this script so a successful match
      // doesn't leave the other form behind in `unmatched` and produce a
      // false "Script not found".
      for (const f of filters) {
        if (f === script.name || f === script._id) unmatched.delete(f);
      }
    }
    saveScriptToFile(script, exportDir);
    emit(`  ← ${script.name}\n`);
  }

  if (unmatched && unmatched.size > 0) {
    for (const u of unmatched) emit(`Script not found: ${u}\n`);
  }
}

async function exportScripts({ exportDir, tenantUrl, realms, prefixes, name, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const prefixList = Array.isArray(prefixes) ? prefixes : [""];
  const emit = typeof log === "function" ? log : () => {};

  // Normalize `name` (string | string[] | undefined) into a filter list.
  // Empty list (no filtering) is represented as null so processScripts
  // saves everything; a non-empty list filters by name OR _id.
  const filters = name == null ? null
    : Array.isArray(name) ? (name.length > 0 ? name : null)
    : [name];

  let queryFilter;
  if (prefixList.length === 0 || (prefixList.length === 1 && prefixList[0] === "")) {
    queryFilter = "true";
  } else {
    queryFilter = prefixList.map((p) => `name+sw+"${p}"`).join("+or+");
  }

  for (const realm of realmList) {
    const amEndpoint = `${tenantUrl}/am/json/${realm}/scripts?_queryFilter=${queryFilter}`;
    const response = await restGet(amEndpoint, null, token);
    const scripts = response.data.result;
    const fileDir = path.join(exportDir, realm, SCRIPT_SUB_DIR);
    const filterDesc = filters
      ? ` filtering for ${filters.length === 1 ? `"${filters[0]}"` : `${filters.length} item(s)`}`
      : "";
    emit(`Fetched ${scripts.length} script(s) from ${realm}${filterDesc}\n`);
    processScripts(scripts, fileDir, filters, emit);
  }
}

async function exportScriptById({ exportDir, tenantUrl, realm, id, token }) {
  const amEndpoint = `${tenantUrl}/am/json/${realm}/scripts/${id}`;
  const response = await restGet(amEndpoint, null, token);
  const fileDir = path.join(exportDir, realm, SCRIPT_SUB_DIR);
  saveScriptToFile(response.data, fileDir);
}

module.exports = { exportScripts, exportScriptById };
