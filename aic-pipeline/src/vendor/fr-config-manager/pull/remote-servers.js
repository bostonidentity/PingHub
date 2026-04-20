/*
 * Dual of update-remote-servers.js. Upstream doesn't ship a dedicated pull
 * script for remote-servers; IDM serves the config under
 * /openidm/config/provisioner.openicf.connectorinfoprovider.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

async function pullRemoteServers({ exportDir, tenantUrl, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const endpoint = `${tenantUrl}/openidm/config/provisioner.openicf.connectorinfoprovider`;
  emit(`GET ${endpoint}\n`);
  let response;
  try {
    response = await restGet(endpoint, null, token);
  } catch (e) {
    if (e?.response?.status === 404) {
      emit(`Warning: no RCS config (404)\n`);
      return;
    }
    throw e;
  }

  const dir = path.join(exportDir, "sync", "rcs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "provisioner.openicf.connectorinfoprovider.json"), JSON.stringify(response.data, null, 2));
  emit(`  ← provisioner.openicf.connectorinfoprovider.json\n`);
}

module.exports = { pullRemoteServers };
