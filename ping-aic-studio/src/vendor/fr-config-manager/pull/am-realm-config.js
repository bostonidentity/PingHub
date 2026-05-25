/*
 * Generic AM realm-config pull — replaces
 * `amRealmConfig.exportConfig(exportDir, realms, configName, ...)` in upstream.
 * Used for scopes whose payload lives at:
 *   /am/json/realms/root/realms/<realm>/realm-config/<configName>
 * (e.g. "authentication"). One file written per realm.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "realm-config";

async function pullAmRealmConfig({ exportDir, tenantUrl, token, realms, configName, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  if (!configName) throw new Error("configName is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/${configName}`;
    emit(`GET ${amEndpoint}\n`);
    const response = await restGet(amEndpoint, null, token);

    const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, `${configName}.json`),
      JSON.stringify(response.data, null, 2),
    );
    emit(`  ← ${realm}/realm-config/${configName}\n`);
  }
}

module.exports = { pullAmRealmConfig };
