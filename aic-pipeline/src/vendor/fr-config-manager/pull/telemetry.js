/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/telemetry.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "telemetry";

function headerEnvVariable(category, name, headerName) {
  return `\${TELEMETRY_HEADER_${category}_${name}_${headerName}}`.replaceAll("-", "_").toUpperCase();
}

async function pullTelemetry({ exportDir, tenantUrl, token, name, category, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const endpoint = `${tenantUrl}/environment/telemetry`;
  emit(`GET ${endpoint}\n`);
  const response = await restGet(endpoint, null, token);

  const targetDir = path.join(exportDir, EXPORT_SUBDIR);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const config = response.data;
  for (const telemetryCategory of Object.keys(config)) {
    if (category && category !== telemetryCategory) continue;
    const providers = config[telemetryCategory];
    if (!Array.isArray(providers) || providers.length === 0) continue;

    const jsonDir = path.join(targetDir, telemetryCategory);
    if (!fs.existsSync(jsonDir)) fs.mkdirSync(jsonDir, { recursive: true });

    for (const provider of providers) {
      if (name && name !== provider.id) continue;
      if (provider.headers) {
        for (const headerName of Object.keys(provider.headers)) {
          provider.headers[headerName] = headerEnvVariable(telemetryCategory, provider.id, headerName);
        }
      }
      fs.writeFileSync(path.join(jsonDir, `${provider.id}.json`), JSON.stringify(provider, null, 2));
      emit(`  ← ${telemetryCategory}/${provider.id}\n`);
    }
  }
}

module.exports = { pullTelemetry };
