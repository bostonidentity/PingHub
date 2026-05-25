/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/csp.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes: CSP_POLICIES constant inlined. Dropped cspOverridesFile
 * feature (unused by the app; would require vendoring lodash.merge).
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const CSP_POLICIES = ["enforced", "report-only"];

async function pullCsp({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(exportDir, "csp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const policies = name ? [name] : CSP_POLICIES;
  const csp = {};

  for (const policy of policies) {
    const endpoint = `${tenantUrl}/environment/content-security-policy/${policy}`;
    const response = await restGet(endpoint, null, token);
    csp[policy] = response.data;
    emit(`  ← ${policy}\n`);
  }

  fs.writeFileSync(path.join(dir, "csp.json"), JSON.stringify(csp, null, 2));
  emit(`Wrote csp/csp.json\n`);
}

module.exports = { pullCsp, CSP_POLICIES };
