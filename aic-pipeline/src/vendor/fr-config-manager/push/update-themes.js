/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-themes.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet, restPut } = require("../common/restClient.js");
const { THEME_HTML_FIELDS } = require("../pull/themes.js");

function encodeOrNot(input, encoded) {
  return encoded ? Buffer.from(input).toString("base64") : input;
}

function processTheme(theme, themePath) {
  for (const field of THEME_HTML_FIELDS) {
    if (!theme[field.name]) continue;
    if (typeof theme[field.name] === "string") continue;

    if (theme[field.name].file) {
      const breakoutFile = path.join(themePath, theme[field.name].file);
      const fieldValue = fs.readFileSync(breakoutFile, "utf-8");
      theme[field.name] = encodeOrNot(fieldValue, field.encoded);
      continue;
    }

    if (typeof theme[field.name] !== "object") {
      throw new Error(`Unexpected data type for ${field.name} in theme ${theme.name}: ${typeof theme[field.name]}`);
    }

    for (const locale of Object.keys(theme[field.name])) {
      const breakoutFile = path.join(themePath, theme[field.name][locale].file);
      const fieldValue = fs.readFileSync(breakoutFile, "utf-8");
      theme[field.name][locale] = encodeOrNot(fieldValue, field.encoded);
    }
  }
  return theme;
}

function mergeExistingThemes(existingThemes, newTheme) {
  const i = existingThemes.findIndex((el) => el.name === newTheme.name);
  if (i >= 0) existingThemes.splice(i, 1);
  existingThemes.push(newTheme);
  return existingThemes;
}

async function pushThemes({ configDir, tenantUrl, realms, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  if (name && realmList.length !== 1) {
    throw new Error("for a named theme, specify a single realm");
  }

  const resourceUrl = `${tenantUrl}/openidm/config/ui/themerealm`;
  emit(`GET ${resourceUrl}\n`);
  const response = await restGet(resourceUrl, null, token);
  const themerealm = response.data;
  if (!themerealm.realm) themerealm.realm = {};

  for (const realm of realmList) {
    const dir = path.join(configDir, "realms", realm, "themes");
    if (!fs.existsSync(dir)) {
      emit(`Warning: no themes config for realm ${realm} at ${dir}\n`);
      continue;
    }

    const themeDirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));

    let realmthemes = [];
    let mergedWithExisting = false;
    for (const themePath of themeDirs) {
      const themeName = path.parse(themePath).base;
      if (name && name !== themeName) continue;

      const theme = JSON.parse(fs.readFileSync(path.join(themePath, `${themeName}.json`), "utf-8"));
      const flattened = processTheme(theme, themePath);

      if (name) {
        realmthemes = mergeExistingThemes(themerealm.realm[realm] ?? [], flattened);
        mergedWithExisting = true;
        break;
      }
      realmthemes.push(flattened);
    }

    if (!mergedWithExisting) {
      themerealm.realm[realm] = realmthemes;
    } else {
      themerealm.realm[realm] = realmthemes;
    }
  }

  emit(`PUT ${resourceUrl}\n`);
  await restPut(resourceUrl, themerealm, token);
}

module.exports = { pushThemes };
