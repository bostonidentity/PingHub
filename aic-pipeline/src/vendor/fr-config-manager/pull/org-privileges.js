/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/orgPrivileges.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - ORG_PRIVILEGES_CONFIG allowlist inlined (single constants file not worth
 *     vendoring for three strings).
 *   - Takes options bag; throws on error (not process.exit(1)).
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const ORG_PRIVILEGES_CONFIG = [
  "alphaOrgPrivileges",
  "bravoOrgPrivileges",
  "privilegeAssignments",
];

async function pullOrgPrivileges({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const filePath = path.join(exportDir, "org-privileges");
  if (!fs.existsSync(filePath)) fs.mkdirSync(filePath, { recursive: true });

  for (const configEntry of ORG_PRIVILEGES_CONFIG) {
    if (name && name !== configEntry) continue;
    const idmEndpoint = `${tenantUrl}/openidm/config/${configEntry}`;
    emit(`GET ${idmEndpoint}\n`);
    const response = await restGet(idmEndpoint, null, token);
    fs.writeFileSync(
      path.join(filePath, `${configEntry}.json`),
      JSON.stringify(response.data, null, 2),
    );
    emit(`  ← ${configEntry}\n`);
  }
}

module.exports = { pullOrgPrivileges, ORG_PRIVILEGES_CONFIG };
