/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-terms-and-conditions.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter changes: dropped replaceSensitiveValues helper (the app's env-var
 * substitution happens elsewhere in the pipeline). Files are read as-is.
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushTermsAndConditions({ configDir, tenantUrl, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "terms-conditions");
  const jsonPath = path.join(dir, "terms-conditions.json");
  if (!fs.existsSync(jsonPath)) {
    emit(`Warning: no terms-and-conditions config at ${jsonPath}\n`);
    return;
  }

  const terms = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

  for (const version of terms.versions ?? []) {
    for (const [language, value] of Object.entries(version.termsTranslations ?? {})) {
      if (value && typeof value === "object" && value.file) {
        const filePath = path.join(dir, value.file);
        if (fs.existsSync(filePath)) {
          version.termsTranslations[language] = fs.readFileSync(filePath, "utf-8");
        } else {
          emit(`Warning: translation file missing: ${filePath}\n`);
        }
      }
    }
  }

  const requestUrl = `${tenantUrl}/openidm/config/selfservice.terms`;
  emit(`PUT ${requestUrl}\n`);
  await restPut(requestUrl, terms, token);
}

module.exports = { pushTermsAndConditions };
