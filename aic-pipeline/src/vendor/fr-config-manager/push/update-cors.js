/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-cors.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushCors({ configDir, tenantUrl, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const filePath = path.join(configDir, "cors", "cors-config.json");
  if (!fs.existsSync(filePath)) {
    emit(`Warning: no cors config at ${filePath}\n`);
    return;
  }
  const body = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  const serviceUrl = `${tenantUrl}/am/json/global-config/services/CorsService`;
  const idmUrl = `${tenantUrl}/openidm/config/servletfilter/cors`;

  if (body.corsServiceGlobal) delete body.corsServiceGlobal._rev;

  emit(`PUT ${serviceUrl} (global)\n`);
  await restPut(serviceUrl, body.corsServiceGlobal, token, "protocol=2.0,resource=1.0");

  emit(`PUT ${idmUrl}\n`);
  await restPut(idmUrl, body.idmCorsConfig, token);

  for (const svc of body.corsServices ?? []) {
    const url = `${serviceUrl}/configuration/${svc._id}`;
    emit(`PUT ${url}\n`);
    await restPut(url, svc, token, "protocol=2.0,resource=1.0");
  }
}

module.exports = { pushCors };
