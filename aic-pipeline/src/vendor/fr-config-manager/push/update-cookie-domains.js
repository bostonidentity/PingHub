/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-cookie-domains.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushCookieDomains({ configDir, tenantUrl, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "cookie-domains");
  const filePath = path.join(dir, "cookie-domains.json");
  if (!fs.existsSync(filePath)) {
    emit(`Warning: no cookie-domains config at ${filePath}\n`);
    return;
  }
  const body = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  const serviceUrl = `${tenantUrl}/environment/cookie-domains`;
  emit(`PUT ${serviceUrl}\n`);
  await restPut(serviceUrl, body, token, "protocol=2.0,resource=1.0");
}

module.exports = { pushCookieDomains };
