/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-internal-roles.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushInternalRoles({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "internal-roles");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no internal-roles config at ${dir}\n`);
    return;
  }

  const files = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
  for (const file of files) {
    const role = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    if (name && name !== role.name) continue;

    delete role._rev;
    if (role.temporalConstraints && role.temporalConstraints.length === 0) {
      delete role.temporalConstraints;
    }

    const requestUrl = `${tenantUrl}/openidm/internal/role/${role._id}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, role, token);
  }
}

module.exports = { pushInternalRoles };
