/*
 * Generic AM realm-config push — mirrors upstream's update-realm-config.js.
 * Reads {configDir}/realms/<realm>/realm-config/<configName>.json and PUTs
 * to /am/json/realms/root/realms/<realm>/realm-config/<configName>.
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushAmRealmConfig({ configDir, tenantUrl, token, realms, configName, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  if (!configName) throw new Error("configName is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const filePath = path.join(configDir, "realms", realm, "realm-config", `${configName}.json`);
    if (!fs.existsSync(filePath)) {
      emit(`Warning: no ${configName} config for realm ${realm} at ${filePath}\n`);
      continue;
    }
    const body = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    delete body._rev;

    const requestUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/${configName}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, body, token, "protocol=1.0,resource=1.0");
  }
}

module.exports = { pushAmRealmConfig };
