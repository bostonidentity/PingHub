/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/cookieDomains.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

async function pullCookieDomains({ exportDir, tenantUrl, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const endpoint = `${tenantUrl}/environment/cookie-domains`;
  emit(`GET ${endpoint}\n`);
  const response = await restGet(endpoint, null, token);

  const dir = path.join(exportDir, "cookie-domains");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cookie-domains.json"), JSON.stringify(response.data, null, 2));
  emit(`  ← cookie-domains.json\n`);
}

module.exports = { pullCookieDomains };
