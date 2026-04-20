/*
 * In-process AM Policy Agents pull — replaces `frodo agent export -A`.
 *
 * Iterates every configured realm and every agent type returned by AM's
 * /agents base endpoint, then for each agent writes one JSON file per id.
 * Layout: {exportDir}/realms/<realm>/agents/<type>/<id>.json
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const BASE_SUBDIR = "agents";

function escapePlaceholders(input) {
  if (typeof input === "string") return input.replace(/\$\{/g, "\\${");
  if (Array.isArray(input)) return input.map(escapePlaceholders);
  if (input && typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = escapePlaceholders(v);
    return out;
  }
  return input;
}

async function pullAmAgents({ exportDir, tenantUrl, token, realms, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const agentsBase = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/agents`;
    // Discover agent types via queryFilter=true on the umbrella agents endpoint.
    emit(`GET ${agentsBase}\n`);
    const listRes = await restGet(agentsBase, { _queryFilter: "true" }, token);
    const agentEntries = listRes.data.result ?? [];

    for (const entry of agentEntries) {
      const agentId = entry._id;
      const agentType = entry._type?._id;
      if (!agentType || !agentId) continue;
      if (name && name !== agentId) continue;

      const agentUrl = `${agentsBase}/${agentType}/${agentId}`;
      const agent = (await restGet(agentUrl, null, token)).data;

      const typeDir = path.join(exportDir, "realms", realm, BASE_SUBDIR, agentType);
      if (!fs.existsSync(typeDir)) fs.mkdirSync(typeDir, { recursive: true });
      fs.writeFileSync(
        path.join(typeDir, `${agentId}.json`),
        JSON.stringify(escapePlaceholders(agent), null, 2),
      );
      emit(`  ← ${realm}/${agentType}/${agentId}\n`);
    }
  }
}

module.exports = { pullAmAgents };
