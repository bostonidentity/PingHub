/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/locales.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes:
 *   - LOCAL PATCH: awaits each locale restGet. Upstream uses `.then()` inside
 *     forEach without awaiting, so the function returns before writes complete.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

async function pullLocales({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const listEndpoint = `${tenantUrl}/openidm/config`;
  emit(`GET ${listEndpoint} (_queryFilter=_id sw "uilocale/")\n`);
  const listResponse = await restGet(listEndpoint, { _queryFilter: '_id sw "uilocale/"' }, token);
  const locales = listResponse.data.result;

  const dir = path.join(exportDir, "locales");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (const locale of locales) {
    const localeName = locale._id.split("/")[1];
    if (name && name !== localeName) continue;

    const idmEndpoint = `${tenantUrl}/openidm/config/${locale._id}`;
    const response = await restGet(idmEndpoint, null, token);
    fs.writeFileSync(path.join(dir, `${localeName}.json`), JSON.stringify(response.data, null, 2));
    emit(`  ← ${localeName}\n`);
  }
}

module.exports = { pullLocales };
