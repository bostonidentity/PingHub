/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-telemetry.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");
const { replaceEnvSpecificValues } = require("../common/config-process.js");

async function pushTelemetry({ configDir, tenantUrl, token, name, category, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  if (name && !category) {
    throw new Error("named telemetry push requires a category");
  }

  const dir = path.join(configDir, "telemetry");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no telemetry config at ${dir}\n`);
    return;
  }

  const categories = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  let configFound = !name;

  for (const telemetryCategory of categories) {
    if (category && category !== telemetryCategory) continue;
    const providerDir = path.join(dir, telemetryCategory);
    const providerFiles = fs.readdirSync(providerDir).filter((n) => path.extname(n) === ".json");

    for (const providerFile of providerFiles) {
      const rawContent = fs.readFileSync(path.join(providerDir, providerFile), "utf-8");
      const provider = JSON.parse(replaceEnvSpecificValues(rawContent, false, envVars));
      if (name && name !== provider.id) continue;
      configFound = true;

      const requestUrl = `${tenantUrl}/environment/telemetry/${telemetryCategory}/${provider.id}`;
      emit(`PUT ${requestUrl}\n`);
      await restPut(requestUrl, provider, token, "protocol=1.0,resource=1.0");
    }
  }

  if (name && !configFound) {
    emit(`Warning: telemetry ${category}/${name} not found on disk\n`);
  }
}

module.exports = { pushTelemetry };
