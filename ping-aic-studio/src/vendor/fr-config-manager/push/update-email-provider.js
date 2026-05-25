/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-email-provider.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushEmailProvider({ configDir, tenantUrl, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const filePath = path.join(configDir, "email-provider", "external.email.json");
  if (!fs.existsSync(filePath)) {
    emit(`Warning: no email-provider config at ${filePath}\n`);
    return;
  }
  const body = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const requestUrl = `${tenantUrl}/openidm/config/external.email`;
  emit(`PUT ${requestUrl}\n`);
  await restPut(requestUrl, body, token);
}

module.exports = { pushEmailProvider };
