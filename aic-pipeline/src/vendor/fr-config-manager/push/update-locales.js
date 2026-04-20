/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-locales.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushLocales({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "locales");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no locales config at ${dir}\n`);
    return;
  }

  const files = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
  for (const file of files) {
    const body = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    const localeName = body._id ? body._id.split("/")[1] : path.basename(file, ".json");
    if (name && name !== localeName) continue;

    const url = `${tenantUrl}/openidm/config/${body._id}`;
    emit(`PUT ${url}\n`);
    await restPut(url, body, token);
  }
}

module.exports = { pushLocales };
