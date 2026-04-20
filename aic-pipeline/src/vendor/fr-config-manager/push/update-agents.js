/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-agents.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter: continue instead of return on missing realm dir (upstream's
 * `return` exits the whole function after first missing realm).
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");
const { replaceEnvSpecificValues } = require("../common/config-process.js");

async function pushOauth2Agents({ configDir, tenantUrl, realms, token, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const baseDir = path.join(configDir, "realms", realm, "realm-config", "agents");
    if (!fs.existsSync(baseDir)) {
      emit(`Warning: no agents config for realm ${realm}\n`);
      continue;
    }

    const agentTypes = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const agentType of agentTypes) {
      const subDir = path.join(baseDir, agentType);
      const agentFiles = fs.readdirSync(subDir).filter((n) => path.extname(n) === ".json");

      for (const agentFile of agentFiles) {
        const rawContent = fs.readFileSync(path.join(subDir, agentFile), "utf-8");
        const resolved = replaceEnvSpecificValues(rawContent, false, envVars);
        const agentObject = JSON.parse(resolved);
        delete agentObject._rev;

        const requestUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/agents/${agentType}/${agentObject._id}`;
        emit(`PUT ${requestUrl}\n`);
        await restPut(requestUrl, agentObject, token, "protocol=2.0,resource=1.0");
      }
    }
  }
}

module.exports = { pushOauth2Agents };
