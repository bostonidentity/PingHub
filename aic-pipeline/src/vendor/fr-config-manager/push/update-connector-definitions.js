/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-connector-definitions.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushConnectorDefinitions({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "sync", "connectors");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no connectors config at ${dir}\n`);
    return;
  }

  const files = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
  for (const file of files) {
    const connector = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    const connectorName = connector._id.split("/")[1];
    if (name && name !== connectorName) continue;
    const requestUrl = `${tenantUrl}/openidm/config/${connector._id}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, connector, token);
  }
}

module.exports = { pushConnectorDefinitions };
