/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-secret-mappings.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter: awaited sequential loop instead of upstream's concurrent Promise.all
 * over async map (for deterministic ordering).
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushSecretMappings({ configDir, tenantUrl, realms, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  if (name && realmList.length !== 1) {
    throw new Error("for a named secret mapping, specify a single realm");
  }

  for (const realm of realmList) {
    const dir = path.join(configDir, "realms", realm, "secret-mappings");
    if (!fs.existsSync(dir)) {
      emit(`Warning: no secret-mappings config for realm ${realm}\n`);
      continue;
    }

    const files = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
    for (const file of files) {
      const body = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      const mappingName = body._id;
      if (name && name !== mappingName) continue;
      delete body._rev;

      const requestUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/secrets/stores/GoogleSecretManagerSecretStoreProvider/ESV/mappings/${mappingName}`;
      emit(`PUT ${requestUrl}\n`);
      await restPut(requestUrl, body, token, "protocol=2.0,resource=1.0");
    }
  }
}

module.exports = { pushSecretMappings };
