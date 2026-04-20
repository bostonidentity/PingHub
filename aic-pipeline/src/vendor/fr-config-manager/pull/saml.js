/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/saml.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Pull requires a descriptor file:
 *   { "<realm>": { samlProviders: [{ entityId, overrides?, replacements?, fileName? }], circlesOfTrust: ["<name>", ...] } }
 * Skips gracefully if no descriptor provided.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "realm-config/saml";

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

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function replaceAllInJson(content, replacements) {
  let json = JSON.stringify(content);
  for (const [from, to] of Object.entries(replacements ?? {})) {
    json = json.split(from).join(to);
  }
  return JSON.parse(json);
}

function safeFileNameUnderscore(name) {
  return name.replace(/[^a-zA-Z0-9_.]/g, "_");
}

async function pullSaml({ exportDir, tenantUrl, token, descriptorFile, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  if (!descriptorFile || !fs.existsSync(descriptorFile)) {
    emit(`saml: no descriptor file at ${descriptorFile ?? "(unset)"} — skipping\n`);
    return;
  }

  const samlConfig = JSON.parse(fs.readFileSync(descriptorFile, "utf-8"));
  for (const realm of Object.keys(samlConfig)) {
    const amSamlBaseUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/saml2`;

    for (const entry of samlConfig[realm].samlProviders ?? []) {
      const entityId = entry.entityId;
      const queryEndpoint = `${amSamlBaseUrl}?_queryFilter=entityId%20eq%20'${encodeURIComponent(entityId)}'`;
      emit(`GET ${queryEndpoint}\n`);
      const query = (await restGet(queryEndpoint, null, token)).data;
      if (query.resultCount !== 1) {
        emit(`SAML entity does not exist: ${entityId}\n`);
        continue;
      }

      const samlId = query.result[0]._id;
      const samlLocation = query.result[0].location;
      const entityEndpoint = `${amSamlBaseUrl}/${samlLocation}/${samlId}`;
      emit(`GET ${entityEndpoint}\n`);
      let config = escapePlaceholders((await restGet(entityEndpoint, null, token)).data);
      if (entry.overrides) config = deepMerge(config, entry.overrides);
      if (entry.replacements) config = replaceAllInJson(config, entry.replacements);

      const metadataUrl = `${tenantUrl}/am/saml2/jsp/exportmetadata.jsp?entityid=${encodeURIComponent(entityId)}&realm=${encodeURIComponent(realm)}`;
      emit(`GET ${metadataUrl}\n`);
      const metadata = (await restGet(metadataUrl, null, token)).data;

      const fileName = entry.fileName ?? safeFileNameUnderscore(entityId);
      const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR, samlLocation);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, `${fileName}.json`), JSON.stringify({ config, metadata }, null, 2));
      emit(`  ← ${realm}/${samlLocation}/${fileName}\n`);
    }

    for (const cotName of samlConfig[realm].circlesOfTrust ?? []) {
      const cotEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/federation/circlesoftrust/${cotName}`;
      emit(`GET ${cotEndpoint}\n`);
      try {
        const cot = (await restGet(cotEndpoint, null, token)).data;
        const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR, "COT");
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, `${cotName}.json`), JSON.stringify(cot, null, 2));
        emit(`  ← ${realm}/COT/${cotName}\n`);
      } catch (e) {
        if (e?.response?.status === 404) {
          emit(`COT does not exist: ${cotName}\n`);
        } else {
          throw e;
        }
      }
    }
  }
}

module.exports = { pullSaml };
