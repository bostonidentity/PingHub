/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/secrets.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * IMPORTANT: Pull emits only secret IDs and version numbers; actual values
 * are never fetched or logged. On disk we write placeholder references like
 * ${ESV_<id>} so the push side can substitute from environment variables.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "esvs/secrets";

function esvToEnv(id) {
  // esv-foo-bar → ESV_FOO_BAR
  return id.replace(/-/g, "_").toUpperCase();
}

function escapePlaceholders(input) {
  if (typeof input === "string") return input.replace(/\$\{/g, "\\${");
  if (Array.isArray(input)) return input.map(escapePlaceholders);
  if (input && typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = escapePlaceholders(v);
    return out;
  }
  return input;
}

async function pullSecrets({ exportDir, tenantUrl, token, name, activeOnly, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const envEndpoint = `${tenantUrl}/environment/secrets`;
  emit(`GET ${envEndpoint}\n`);
  const response = await restGet(envEndpoint, null, token);
  const secrets = response.data.result ?? [];

  const targetDir = path.join(exportDir, EXPORT_SUBDIR);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  for (const secret of secrets) {
    if (name && name !== secret._id) continue;

    const secretObject = {
      _id: secret._id,
      encoding: secret.encoding,
      useInPlaceholders: secret.useInPlaceholders,
      description: escapePlaceholders(secret.description),
    };

    if (activeOnly) {
      secretObject.valueBase64 = "${" + esvToEnv(secret._id) + "}";
    } else {
      const versionsEndpoint = `${tenantUrl}/environment/secrets/${secret._id}/versions`;
      // Note: intentionally NOT logging the versions endpoint response.
      const versionsResponse = await restGet(versionsEndpoint, null, token);
      const versions = (versionsResponse.data ?? []).filter((v) => v.status !== "DESTROYED");

      secretObject.versions = versions.map((v, i) => ({
        version: (i + 1).toString(),
        status: v.status,
        valueBase64: "${" + esvToEnv(`${secret._id}_${i + 1}`) + "}",
      }));
    }

    fs.writeFileSync(path.join(targetDir, `${secret._id}.json`), JSON.stringify(secretObject, null, 2));
    emit(`  ← ${secret._id}\n`);
  }
}

module.exports = { pullSecrets };
