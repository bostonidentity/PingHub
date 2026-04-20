/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/raw.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Pull requires either a descriptor file listing { path, pushApiVersion, overrides }
 * entries OR a single `requestedPath`. If neither provided, the pull is a no-op.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const RAW_SUBDIR = "raw";

function escapePlaceholders(input) {
  if (typeof input === "string") return input.replace(/\$\{/g, "\\${");
  if (Array.isArray(input)) return input.map(escapePlaceholders);
  if (input && typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = escapePlaceholders(v);
    return out;
  }
  return input;
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

async function pullRawConfig({ exportDir, tenantUrl, token, requestedPath, requestedPushApiVersion, descriptorFile, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  let rawConfigs = null;
  if (requestedPath) {
    const entry = { path: requestedPath };
    if (requestedPushApiVersion) entry.pushApiVersion = requestedPushApiVersion;
    rawConfigs = [entry];
  } else if (descriptorFile && fs.existsSync(descriptorFile)) {
    rawConfigs = JSON.parse(fs.readFileSync(descriptorFile, "utf-8"));
  } else {
    emit(`raw: no descriptor or requestedPath — skipping\n`);
    return;
  }

  for (const rawConfig of rawConfigs) {
    let urlPath = rawConfig.path;
    if (!urlPath.startsWith("/")) urlPath = `/${urlPath}`;

    const endpoint = `${tenantUrl}${urlPath}`;
    emit(`GET ${endpoint}\n`);
    const response = await restGet(endpoint, null, token);

    let config = escapePlaceholders(response.data);
    if (rawConfig.overrides) config = deepMerge(config, rawConfig.overrides);
    if (rawConfig.pushApiVersion) config._pushApiVersion = rawConfig.pushApiVersion;

    const fullPath = path.join(exportDir, RAW_SUBDIR, `${urlPath}.json`);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(config, null, 2));
    emit(`  ← ${urlPath.replace(/^\//, "")}\n`);
  }
}

module.exports = { pullRawConfig };
