/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/secretMappings.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "secret-mappings";

async function pullSecretMappings({ exportDir, tenantUrl, realms, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/secrets/stores/GoogleSecretManagerSecretStoreProvider/ESV/mappings`;
    emit(`GET ${amEndpoint}\n`);
    const response = await restGet(amEndpoint, { _queryFilter: "true" }, token);

    const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    for (const mapping of response.data.result ?? []) {
      if (name && name !== mapping._id) continue;
      fs.writeFileSync(path.join(targetDir, `${mapping._id}.json`), JSON.stringify(mapping, null, 2));
      emit(`  ← ${realm}/${mapping._id}\n`);
    }
  }
}

module.exports = { pullSecretMappings };
