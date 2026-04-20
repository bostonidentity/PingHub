/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/amServices.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet, restPost } = require("../common/restClient.js");

const EXPORT_SUB_DIR = "services";
const EXCLUDE_SERVICES = ["DataStoreService"];

async function saveDescendents(targetDir, amEndpoint, serviceName, token, emit) {
  const url = `${amEndpoint}/${serviceName}?_action=nextdescendents`;
  emit(`POST ${url}\n`);
  // Upstream used restPost with { _action: nextdescendents } as params
  let response;
  try {
    response = await restPost(`${amEndpoint}/${serviceName}`, { _action: "nextdescendents" }, null, token, "protocol=1.0,resource=1.0");
  } catch (err) {
    // AIC returns 400 when a service has no descendents (e.g. authenticatorPushService).
    // Upstream fr-config-manager lets this bubble up and kill the whole scope, which in
    // AIC means every service alphabetically after the first such offender is skipped.
    // Treat it as "no descendents, move on" to keep the rest of the realm pulling.
    if (err && err.response && err.response.status === 400) {
      emit(`  ℹ no descendents for ${serviceName}\n`);
      return;
    }
    throw err;
  }
  const descendents = response.data.result;
  const serviceDir = path.join(targetDir, serviceName);
  for (const descendent of descendents) {
    if (!fs.existsSync(serviceDir)) fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(path.join(serviceDir, `${descendent._id}.json`), JSON.stringify(descendent, null, 2));
  }
}

async function pullServices({ exportDir, tenantUrl, realms, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUB_DIR);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/services`;
    emit(`GET ${amEndpoint}\n`);
    let response;
    try {
      response = await restGet(amEndpoint, { _queryFilter: "true" }, token);
    } catch (err) {
      // AIC returns 400 for empty services in some realms — treat as "nothing to export"
      if (err && err.response && err.response.status === 400) {
        emit(`  ℹ no services to export in realm ${realm}\n`);
        continue;
      }
      throw err;
    }
    const services = response.data.result;

    for (const service of services) {
      const serviceName = service._id;
      if (EXCLUDE_SERVICES.includes(serviceName)) continue;
      if (name && name !== serviceName) continue;

      const serviceResponse = await restGet(`${amEndpoint}/${serviceName}`, null, token);
      fs.writeFileSync(path.join(targetDir, `${serviceName}.json`), JSON.stringify(serviceResponse.data, null, 2));
      emit(`  ← ${realm}/${serviceName}\n`);

      await saveDescendents(targetDir, amEndpoint, serviceName, token, emit);
    }
  }
}

module.exports = { pullServices };
