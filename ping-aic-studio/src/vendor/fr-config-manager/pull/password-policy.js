/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/fieldPolicy.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - LOCAL PATCH: writes to `{exportDir}/realms/<realm>/password-policy/` to
 *     match the push path. Upstream writes to `{exportDir}/<realm>/password-policy/`
 *     which doesn't round-trip with its own push script.
 *   - Takes options bag; throws on error.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

async function pullPasswordPolicy({ exportDir, tenantUrl, realms, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const objectName = `${realm}_user`;
    const idmEndpoint = `${tenantUrl}/openidm/config/fieldPolicy/${objectName}`;
    emit(`GET ${idmEndpoint}\n`);
    const response = await restGet(idmEndpoint, null, token);

    const targetDir = path.join(exportDir, "realms", realm, "password-policy");
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, `${objectName}-password-policy.json`),
      JSON.stringify(response.data, null, 2),
    );
    emit(`  ← ${realm}/${objectName}-password-policy\n`);
  }
}

module.exports = { pullPasswordPolicy };
