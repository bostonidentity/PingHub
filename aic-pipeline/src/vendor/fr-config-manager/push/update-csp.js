/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-csp.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");
const { CSP_POLICIES } = require("../pull/csp.js");

async function pushCsp({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const cspFile = path.join(configDir, "csp", "csp.json");
  if (!fs.existsSync(cspFile)) {
    emit(`Warning: no csp config at ${cspFile}\n`);
    return;
  }
  const csp = JSON.parse(fs.readFileSync(cspFile, "utf-8"));

  const policies = name ? [name] : CSP_POLICIES;
  if (name && !csp[name]) {
    emit(`Warning: no config in csp.json for policy ${name}\n`);
    return;
  }

  for (const policy of policies) {
    if (!csp[policy]) continue;
    const url = `${tenantUrl}/environment/content-security-policy/${policy}`;
    emit(`PUT ${url}\n`);
    await restPut(url, csp[policy], token);
  }
}

module.exports = { pushCsp };
