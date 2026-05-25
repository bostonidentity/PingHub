/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/mappings.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter: process.exit(1) replaced with throw.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "sync/mappings";

async function pullConnectorMappings({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/config/sync`;
  emit(`GET ${idmEndpoint}\n`);
  let response;
  try {
    response = await restGet(idmEndpoint, null, token);
  } catch (e) {
    if (e?.response?.status === 404) {
      emit(`Warning: no sync mapping config (404)\n`);
      return;
    }
    throw e;
  }
  const mappings = response.data.mappings ?? [];

  const targetDir = path.join(exportDir, EXPORT_SUBDIR);
  for (const mapping of mappings) {
    if (name && name !== mapping.name) continue;
    const mappingPath = path.join(targetDir, mapping.name);
    if (!fs.existsSync(mappingPath)) fs.mkdirSync(mappingPath, { recursive: true });

    for (const [key, value] of Object.entries(mapping)) {
      if (value && value.type === "text/javascript" && value.source) {
        const scriptFilename = `${mapping.name}.${key}.js`;
        mapping[key] = { ...value, file: scriptFilename };
        delete mapping[key].source;
        fs.writeFileSync(path.join(mappingPath, scriptFilename), value.source);
      }
    }
    fs.writeFileSync(path.join(mappingPath, `${mapping.name}.json`), JSON.stringify(mapping, null, 2));
    emit(`  ← ${mapping.name}\n`);
  }
}

module.exports = { pullConnectorMappings };
