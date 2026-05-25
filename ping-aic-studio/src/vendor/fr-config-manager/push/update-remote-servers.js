/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-remote-servers.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushRemoteServers({ configDir, tenantUrl, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const configFile = path.join(configDir, "sync", "rcs", "provisioner.openicf.connectorinfoprovider.json");
  if (!fs.existsSync(configFile)) {
    emit(`Warning: no RCS config at ${configFile}\n`);
    return;
  }

  const body = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const requestUrl = `${tenantUrl}/openidm/config/provisioner.openicf.connectorinfoprovider`;
  emit(`PUT ${requestUrl}\n`);
  await restPut(requestUrl, body, token);
}

module.exports = { pushRemoteServers };
