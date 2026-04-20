/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/connectors.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const CONNECTORS_SUBDIR = "sync/connectors";

async function pullConnectorDefinitions({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/config`;
  emit(`GET ${idmEndpoint} (connectors)\n`);
  const response = await restGet(idmEndpoint, { _queryFilter: '_id sw "provisioner.openicf/"' }, token);

  const fileDir = path.join(exportDir, CONNECTORS_SUBDIR);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

  for (const connector of response.data.result) {
    const connectorName = connector._id.split("/")[1];
    if (name && name !== connectorName) continue;
    fs.writeFileSync(path.join(fileDir, `${connectorName}.json`), JSON.stringify(connector, null, 2));
    emit(`  ← ${connectorName}\n`);
  }
}

module.exports = { pullConnectorDefinitions };
