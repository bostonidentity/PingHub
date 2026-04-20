/*
 * In-process AM Policy Agents push — replaces `frodo agent import -A`.
 *
 * Walks {configDir}/realms/<realm>/agents/<type>/<id>.json and PUTs each to
 * /am/json/realms/root/realms/<realm>/realm-config/agents/<type>/<id>.
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");
const { replaceEnvSpecificValues } = require("../common/config-process.js");

async function pushAmAgents({ configDir, tenantUrl, token, realms, name, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const baseDir = path.join(configDir, "realms", realm, "agents");
    if (!fs.existsSync(baseDir)) {
      emit(`Warning: no AM agents config for realm ${realm}\n`);
      continue;
    }

    const typeDirs = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const type of typeDirs) {
      const subDir = path.join(baseDir, type);
      const files = fs.readdirSync(subDir).filter((n) => path.extname(n) === ".json");

      for (const file of files) {
        const raw = fs.readFileSync(path.join(subDir, file), "utf-8");
        const resolved = replaceEnvSpecificValues(raw, false, envVars);
        const agent = JSON.parse(resolved);
        const agentId = agent._id ?? path.basename(file, ".json");
        if (name && name !== agentId) continue;
        delete agent._rev;

        const url = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/agents/${type}/${agentId}`;
        emit(`PUT ${url}\n`);
        await restPut(url, agent, token, "protocol=2.0,resource=1.0");
      }
    }
  }
}

module.exports = { pushAmAgents };
