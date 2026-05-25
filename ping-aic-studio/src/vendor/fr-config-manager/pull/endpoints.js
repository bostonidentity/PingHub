/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/endpoints.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const ENDPOINT_SUBDIR = "endpoints";

async function pullEndpoints({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/config`;
  const queryFilter = '!(file pr) and _id sw "endpoint" and !(context sw "util") and !(_id eq "endpoint/linkedView")';
  emit(`GET ${idmEndpoint} (endpoints)\n`);
  const response = await restGet(idmEndpoint, { _queryFilter: queryFilter }, token);

  const fileDir = path.join(exportDir, ENDPOINT_SUBDIR);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

  for (const endpoint of response.data.result) {
    const endpointName = endpoint._id.split("/")[1];
    if (name && name !== endpointName) continue;

    const endpointDir = path.join(fileDir, endpointName);
    if (!fs.existsSync(endpointDir)) fs.mkdirSync(endpointDir, { recursive: true });

    const scriptFilename = `${endpointName}.js`;
    fs.writeFileSync(path.join(endpointDir, scriptFilename), endpoint.source ?? "");
    delete endpoint.source;
    endpoint.file = scriptFilename;

    fs.writeFileSync(
      path.join(endpointDir, `${endpointName}.json`),
      JSON.stringify(endpoint, null, 2),
    );
    emit(`  ← ${endpointName}\n`);
  }
}

module.exports = { pullEndpoints };
