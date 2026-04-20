/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/idmFlatConfig.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Takes exportDir / subdir / filename / endpointName / tenantUrl / token /
 *     log as an options bag. Throws on network error instead of swallowing
 *     with console.error + silent return.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

async function pullIdmFlatConfig({ exportDir, subdir, filename, endpointName, tenantUrl, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!subdir) throw new Error("subdir is required");
  if (!filename) throw new Error("filename is required");
  if (!endpointName) throw new Error("endpointName is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/config/${endpointName}`;
  emit(`GET ${idmEndpoint}\n`);
  const response = await restGet(idmEndpoint, null, token);

  const targetDir = path.join(exportDir, subdir);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, filename), JSON.stringify(response.data, null, 2));
  emit(`  ← ${subdir}/${filename}\n`);
}

module.exports = { pullIdmFlatConfig };
