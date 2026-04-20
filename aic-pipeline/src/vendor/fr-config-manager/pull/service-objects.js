/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/serviceObjects.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Pull requires a descriptor file (SERVICE_OBJECTS_CONFIG_FILE) listing which
 * managed-object queries to run. If no descriptor is provided or present,
 * the pull is a no-op.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

function escapePlaceholders(input) {
  // Mirror utils.escapePlaceholders: escape ${ to \\${ in JSON text.
  if (typeof input === "string") {
    return input.replace(/\$\{/g, "\\${");
  }
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

async function pullServiceObjects({ exportDir, tenantUrl, token, descriptorFile, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  if (!descriptorFile || !fs.existsSync(descriptorFile)) {
    emit(`service-objects: no descriptor file at ${descriptorFile ?? "(unset)"} — skipping\n`);
    return;
  }

  const systemObjects = JSON.parse(fs.readFileSync(descriptorFile, "utf-8"));
  for (const objectType of Object.keys(systemObjects)) {
    for (const systemObject of systemObjects[objectType]) {
      const idmEndpoint = `${tenantUrl}/openidm/managed/${objectType}`;
      emit(`GET ${idmEndpoint} (${systemObject.searchField}="${systemObject.searchValue}")\n`);
      const response = await restGet(idmEndpoint, {
        _queryFilter: `${systemObject.searchField} eq "${systemObject.searchValue}"`,
        _fields: systemObject.fields.join(","),
      }, token);

      if (response.data.resultCount !== 1) {
        throw new Error(`Unexpected result for ${objectType} "${systemObject.searchValue}": ${response.data.resultCount} entries`);
      }
      const attributes = escapePlaceholders(response.data.result[0]);
      const merged = deepMerge(attributes, systemObject.overrides ?? {});

      const targetDir = path.join(exportDir, "service-objects", objectType);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, `${systemObject.searchValue}.json`), JSON.stringify(merged, null, 2));
      emit(`  ← ${objectType}/${systemObject.searchValue}\n`);
    }
  }
}

module.exports = { pullServiceObjects };
