/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-raw.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restUpsert } = require("../common/restClient.js");
const { replaceEnvSpecificValues, clearOperationalAttributes } = require("../common/config-process.js");

const DEFAULT_API_VERSION = { protocol: "2.0", resource: "1.0" };

function normalisePath(p) {
  return p.replace(/\\/g, "/");
}

function walkJsonFiles(dir, out = [], baseDir = dir) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonFiles(full, out, baseDir);
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

async function pushRawConfig({ configDir, tenantUrl, token, requestedPath, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const baseDir = path.join(configDir, "raw");
  if (!fs.existsSync(baseDir)) {
    emit(`Warning: no raw config at ${baseDir}\n`);
    return;
  }

  const configFiles = walkJsonFiles(baseDir);
  for (const configFile of configFiles) {
    const urlPath = normalisePath(configFile.slice(baseDir.length).replace(/\.json$/, ""));
    if (requestedPath && !urlPath.startsWith(requestedPath)) continue;

    const rawContent = fs.readFileSync(configFile, "utf-8");
    const resolved = replaceEnvSpecificValues(rawContent, false, envVars);

    let configObject;
    try {
      configObject = JSON.parse(resolved);
    } catch {
      throw new Error(`Error parsing config JSON for ${urlPath}`);
    }

    const apiVersion = configObject._pushApiVersion ?? DEFAULT_API_VERSION;
    const apiVersionHeader = `protocol=${apiVersion.protocol},resource=${apiVersion.resource}`;
    clearOperationalAttributes(configObject);

    const requestUrl = `${tenantUrl}${urlPath}`;
    emit(`UPSERT ${requestUrl}\n`);
    await restUpsert(requestUrl, configObject, token, apiVersionHeader);
  }
}

module.exports = { pushRawConfig };
