/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-service-objects.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");
const { replaceEnvSpecificValues, removeProperty } = require("../common/config-process.js");

async function pushServiceObjects({ configDir, tenantUrl, token, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const baseDir = path.join(configDir, "service-objects");
  if (!fs.existsSync(baseDir)) {
    emit(`Warning: no service-objects config at ${baseDir}\n`);
    return;
  }

  const objectTypes = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const objectType of objectTypes) {
    const subDir = path.join(baseDir, objectType);
    const objectFiles = fs.readdirSync(subDir).filter((n) => path.extname(n) === ".json");

    for (const objectFile of objectFiles) {
      const rawContent = fs.readFileSync(path.join(subDir, objectFile), "utf-8");
      const resolved = replaceEnvSpecificValues(rawContent, false, envVars);
      const objectAttributes = JSON.parse(resolved);

      delete objectAttributes._rev;
      removeProperty(objectAttributes, "_refProperties");

      const resourceUrl = `${tenantUrl}/openidm/managed/${objectType}/${objectAttributes._id}`;
      emit(`PUT ${resourceUrl}\n`);
      await restPut(resourceUrl, objectAttributes, token);
    }
  }
}

module.exports = { pushServiceObjects };
