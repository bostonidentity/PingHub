/*
 * Generalizes @forgerock/fr-config-manager's five IDM flat-config push scripts
 * (update-audit, update-idm-access-config, update-idm-authentication-config,
 * update-kba-config, update-ui-config). Each is a one-file, one-endpoint PUT.
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter differences:
 *   - Parameterized by subdir/filename/endpointName instead of hard-coded per
 *     scope, so one function replaces five upstream files.
 *   - Throws on error instead of process.exit(1).
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushIdmFlatConfig({ configDir, subdir, filename, endpointName, tenantUrl, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!subdir) throw new Error("subdir is required");
  if (!filename) throw new Error("filename is required");
  if (!endpointName) throw new Error("endpointName is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, subdir);
  if (!fs.existsSync(dir)) {
    emit(`Warning: no ${subdir} config defined at ${dir}\n`);
    return;
  }
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) {
    emit(`Warning: ${filePath} missing; skipping push\n`);
    return;
  }
  const body = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  const requestUrl = `${tenantUrl}/openidm/config/${endpointName}`;
  emit(`PUT ${requestUrl}\n`);
  await restPut(requestUrl, body, token);
}

module.exports = { pushIdmFlatConfig };
