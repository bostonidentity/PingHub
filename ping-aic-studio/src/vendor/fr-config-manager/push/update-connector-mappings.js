/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-connector-mappings.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet, restPut } = require("../common/restClient.js");

const EVENT_NAMES = ["onCreate", "onUpdate", "onDelete", "onLink", "onUnlink", "validSource", "validTarget", "result"];

async function mergeExistingMappings(newMapping, resourceUrl, token) {
  const result = await restGet(resourceUrl, null, token);
  const existingMappings = result.data.mappings ?? [];
  const idx = existingMappings.findIndex((el) => el.name === newMapping.name);
  if (idx >= 0) existingMappings.splice(idx, 1);
  existingMappings.push(newMapping);
  return existingMappings;
}

async function pushConnectorMappings({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "sync", "mappings");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no connector-mappings config at ${dir}\n`);
    return;
  }

  let mappings = [];
  const mappingPaths = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name));
  const requestUrl = `${tenantUrl}/openidm/config/sync`;

  for (const mappingPath of mappingPaths) {
    const mappingName = path.parse(mappingPath).base;
    if (name && name !== mappingName) continue;

    const mappingFile = path.join(mappingPath, `${mappingName}.json`);
    if (!fs.existsSync(mappingFile)) continue;
    const mapping = JSON.parse(fs.readFileSync(mappingFile, "utf-8"));

    for (const eventName of EVENT_NAMES) {
      const trigger = mapping[eventName];
      if (!trigger || !trigger.file) continue;
      const scriptPath = path.join(mappingPath, trigger.file);
      if (fs.existsSync(scriptPath)) {
        mapping[eventName].source = fs.readFileSync(scriptPath, "utf-8");
        if (!mapping[eventName].type) mapping[eventName].type = "text/javascript";
        delete mapping[eventName].file;
      }
    }
    mappings.push(mapping);
  }

  if (name) {
    if (mappings.length === 0) {
      throw new Error(`connector-mapping "${name}" not found under ${dir}`);
    }
    mappings = await mergeExistingMappings(mappings[0], requestUrl, token);
  }

  emit(`PUT ${requestUrl} (${mappings.length} mapping${mappings.length === 1 ? "" : "s"})\n`);
  await restPut(requestUrl, { mappings }, token);
}

module.exports = { pushConnectorMappings };
