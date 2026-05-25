/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-org-privileges.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Takes options bag; throws on error (not process.exit(1)).
 *   - ORG_PRIVILEGES_CONFIG imported from vendored pull to share one source of truth.
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");
const { ORG_PRIVILEGES_CONFIG } = require("../pull/org-privileges.js");

async function pushOrgPrivileges({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  if (name && !ORG_PRIVILEGES_CONFIG.includes(name)) {
    throw new Error(`unrecognised org config: ${name}`);
  }

  const dir = path.join(configDir, "org-privileges");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no org-privileges config defined at ${dir}\n`);
    return;
  }

  const files = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
  const orgConfigs = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));

  let configFound = !name;
  for (const orgConfig of orgConfigs) {
    const configName = orgConfig._id;
    if (name && name !== configName) continue;
    if (!ORG_PRIVILEGES_CONFIG.includes(configName)) {
      emit(`Warning: ignoring unrecognised org config ${configName}\n`);
      continue;
    }
    configFound = true;
    const requestUrl = `${tenantUrl}/openidm/config/${configName}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, orgConfig, token);
  }

  if (name && !configFound) {
    emit(`Warning: org config ${name} not found on disk\n`);
  }
}

module.exports = { pushOrgPrivileges };
