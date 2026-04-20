/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-password-policy.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Takes options bag; throws on error (not process.exit(1)).
 *   - Early-return on missing dir continues looping; upstream returns the whole
 *     function after the first missing realm, silently skipping later realms.
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushPasswordPolicy({ configDir, tenantUrl, realms, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const dir = path.join(configDir, "realms", realm, "password-policy");
    if (!fs.existsSync(dir)) {
      emit(`Warning: no password-policy config for realm ${realm} at ${dir}\n`);
      continue;
    }
    const filePath = path.join(dir, `${realm}_user-password-policy.json`);
    if (!fs.existsSync(filePath)) {
      emit(`Warning: ${filePath} missing; skipping realm ${realm}\n`);
      continue;
    }
    const body = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const requestUrl = `${tenantUrl}/openidm/config/${body._id}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, body, token);
  }
}

module.exports = { pushPasswordPolicy };
