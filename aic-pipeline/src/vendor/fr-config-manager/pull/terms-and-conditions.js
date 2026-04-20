/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/termsAndConditions.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUB_DIR = "terms-conditions";
const EXPORT_FILE_NAME = "terms-conditions.json";

async function pullTermsAndConditions({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/config/selfservice.terms`;
  emit(`GET ${idmEndpoint}\n`);
  const response = await restGet(idmEndpoint, null, token);
  const terms = response.data;

  const fileDir = path.join(exportDir, EXPORT_SUB_DIR);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

  for (const version of terms.versions ?? []) {
    if (name && name !== version.version) continue;
    const versionPath = path.join(fileDir, version.version);
    if (!fs.existsSync(versionPath)) fs.mkdirSync(versionPath, { recursive: true });

    emit(`  ← version ${version.version} (${Object.keys(version.termsTranslations ?? {}).length} lang)\n`);

    for (const [language, text] of Object.entries(version.termsTranslations ?? {})) {
      const relFileName = path.join(version.version, `${language}.html`);
      fs.writeFileSync(path.join(fileDir, relFileName), text);
      version.termsTranslations[language] = { file: relFileName };
    }
  }

  fs.writeFileSync(path.join(fileDir, EXPORT_FILE_NAME), JSON.stringify(terms, null, 2));
}

module.exports = { pullTermsAndConditions };
