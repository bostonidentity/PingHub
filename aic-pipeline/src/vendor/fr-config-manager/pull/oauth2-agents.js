/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/oauth2Agents.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Pull requires a descriptor file: { realm: { agentType: [{ id, overrides }] } }.
 * Skips gracefully if no descriptor provided.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "realm-config/agents";

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

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

async function pullOauth2Agents({ exportDir, tenantUrl, token, descriptorFile, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  if (!descriptorFile || !fs.existsSync(descriptorFile)) {
    emit(`oauth2-agents: no descriptor file at ${descriptorFile ?? "(unset)"} — skipping\n`);
    return;
  }

  const agents = JSON.parse(fs.readFileSync(descriptorFile, "utf-8"));
  for (const realm of Object.keys(agents)) {
    for (const agentType of Object.keys(agents[realm])) {
      for (const agent of agents[realm][agentType]) {
        const agentId = agent.id;
        const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/agents/${agentType}/${agentId}`;
        emit(`GET ${amEndpoint}\n`);
        const response = await restGet(amEndpoint, null, token);

        let config = escapePlaceholders(response.data);
        if (agent.overrides) config = deepMerge(config, agent.overrides);

        const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR, agentType);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, `${agentId}.json`), JSON.stringify(config, null, 2));
        emit(`  ← ${realm}/${agentType}/${agentId}\n`);
      }
    }
  }
}

module.exports = { pullOauth2Agents };
