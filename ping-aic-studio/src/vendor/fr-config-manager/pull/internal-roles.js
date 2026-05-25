/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/internalRoles.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter notes: upstream filters roles to those with non-empty privileges
 * (to skip built-in system roles); preserve that behavior.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

async function pullInternalRoles({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/internal/role`;
  emit(`GET ${idmEndpoint}\n`);
  const response = await restGet(idmEndpoint, { _queryFilter: "true" }, token);

  const targetDir = path.join(exportDir, "internal-roles");
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  for (const role of response.data.result) {
    if (name && name !== role.name) continue;
    if (!role.privileges || role.privileges.length === 0) continue;
    fs.writeFileSync(path.join(targetDir, `${role.name}.json`), JSON.stringify(role, null, 2));
    emit(`  ← ${role.name}\n`);
  }
}

module.exports = { pullInternalRoles };
