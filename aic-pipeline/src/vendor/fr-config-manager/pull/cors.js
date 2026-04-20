/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/cors.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes: uses axios directly for the POST call (restClient helper
 * only exports restGet/restPut; rather than extend it with restPost for a
 * single caller, inline here).
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { restGet } = require("../common/restClient.js");

async function pullCors({ exportDir, tenantUrl, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const corsConfig = {};

  const amEndpoint = `${tenantUrl}/am/json/global-config/services/CorsService`;

  emit(`GET ${amEndpoint}\n`);
  const corsGlobal = await restGet(amEndpoint, null, token);
  corsConfig.corsServiceGlobal = corsGlobal.data;

  emit(`POST ${amEndpoint} (nextdescendents)\n`);
  const corsDescendantsResp = await axios({
    method: "POST",
    url: amEndpoint,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Api-Version": "protocol=2.0,resource=1.0",
      "X-Requested-With": "ForgeRock Identity Cloud Postman Collection",
    },
    params: { _action: "nextdescendents" },
    data: {},
    validateStatus: (s) => s >= 200 && s < 300,
  });
  corsConfig.corsServices = corsDescendantsResp.data.result;

  const idmEndpoint = `${tenantUrl}/openidm/config/servletfilter/cors`;
  emit(`GET ${idmEndpoint}\n`);
  const idmResponse = await restGet(idmEndpoint, null, token);
  corsConfig.idmCorsConfig = idmResponse.data;

  const dir = path.join(exportDir, "cors");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cors-config.json"), JSON.stringify(corsConfig, null, 2));
  emit(`  ← cors-config.json (${(corsConfig.corsServices ?? []).length} service${(corsConfig.corsServices ?? []).length === 1 ? "" : "s"})\n`);
}

module.exports = { pullCors };
