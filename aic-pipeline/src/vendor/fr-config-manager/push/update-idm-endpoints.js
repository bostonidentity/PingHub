/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-idm-endpoints.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes:
 *   - Replaced glob dep with fs.readdir walk (same pattern as push/update-auth-trees).
 *   - Dropped fileFilter helper (unused by the app).
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

function nestedEndpointJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(dir, sub.name);
    for (const f of fs.readdirSync(subPath, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".json")) {
        out.push(path.join(sub.name, f.name));
      }
    }
  }
  return out;
}

async function pushEndpoints({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "endpoints");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no endpoints config at ${dir}\n`);
    return;
  }

  const jsonFiles = nestedEndpointJsonFiles(dir);
  let endpointFound = !name;

  for (const jsonFile of jsonFiles) {
    const endpoint = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), "utf-8"));
    const endpointName = endpoint._id.split("/")[1];
    if (name && name !== endpointName) continue;
    endpointFound = true;

    const endpointDir = path.dirname(jsonFile);
    if (endpoint.file) {
      const scriptPath = path.join(dir, endpointDir, endpoint.file);
      if (fs.existsSync(scriptPath)) {
        endpoint.source = fs.readFileSync(scriptPath, "utf-8");
        delete endpoint.file;
      } else {
        emit(`Warning: endpoint script missing at ${scriptPath}\n`);
      }
    }

    const requestUrl = `${tenantUrl}/openidm/config/${endpoint._id}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, endpoint, token);
  }

  if (name && !endpointFound) {
    throw new Error(`endpoint "${name}" not found under ${dir}`);
  }
}

module.exports = { pushEndpoints };
