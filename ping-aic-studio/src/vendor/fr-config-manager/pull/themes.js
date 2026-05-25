/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/themes.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter changes: THEME_HTML_FIELDS inlined. process.exit(1) replaced with throw.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUB_DIR = "themes";
const THEME_HTML_FIELDS = [
  { name: "accountFooter", encoded: false },
  { name: "journeyFooter", encoded: false },
  { name: "journeyHeader", encoded: false },
  { name: "journeyJustifiedContent", encoded: false },
  { name: "journeyFooterScriptTag", encoded: true },
  { name: "accountFooterScriptTag", encoded: true },
];

function isBase64(str) {
  if (typeof str !== "string") return false;
  const re = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;
  return re.test(str);
}

function decodeOrNot(input, encoded) {
  if (!encoded) return input;
  return isBase64(input) ? Buffer.from(input, "base64").toString("utf-8") : input;
}

function processThemes(themes, fileDir, name, emit) {
  for (const theme of themes) {
    if (name && name !== theme.name) continue;

    const themePath = path.join(fileDir, theme.name);
    if (!fs.existsSync(themePath)) fs.mkdirSync(themePath, { recursive: true });

    for (const field of THEME_HTML_FIELDS) {
      if (!theme[field.name]) continue;
      if (typeof theme[field.name] === "string") {
        const fieldFilename = `${field.name}.html`;
        fs.writeFileSync(path.join(themePath, fieldFilename), decodeOrNot(theme[field.name], field.encoded));
        theme[field.name] = { file: fieldFilename };
      } else if (typeof theme[field.name] === "object") {
        const fieldPath = path.join(themePath, field.name);
        if (!fs.existsSync(fieldPath)) fs.mkdirSync(fieldPath, { recursive: true });
        for (const locale of Object.keys(theme[field.name])) {
          const localeFilename = path.join(field.name, `${locale}.html`);
          fs.writeFileSync(path.join(themePath, localeFilename), decodeOrNot(theme[field.name][locale], field.encoded));
          theme[field.name][locale] = { file: localeFilename };
        }
      } else {
        throw new Error(`Unexpected data type for ${field.name} in theme ${theme.name}: ${typeof theme[field.name]}`);
      }
    }

    fs.writeFileSync(path.join(themePath, `${theme.name}.json`), JSON.stringify(theme, null, 2));
    emit(`  ← ${theme.name}\n`);
  }
}

async function pullThemes({ exportDir, tenantUrl, realms, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const idmEndpoint = `${tenantUrl}/openidm/config/ui/themerealm`;
    emit(`GET ${idmEndpoint} (realm=${realm})\n`);
    const response = await restGet(idmEndpoint, { _fields: `realm/${realm}` }, token);
    if (!response.data.realm || !response.data.realm[realm]) continue;

    const fileDir = path.join(exportDir, realm, EXPORT_SUB_DIR);
    processThemes(response.data.realm[realm], fileDir, name, emit);
  }
}

module.exports = { pullThemes, THEME_HTML_FIELDS };
