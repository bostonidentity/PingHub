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

async function pullEntity({ exportDir, tenantUrl, token, realm, entityId, samlId, samlLocation, fileName, emit }) {
  const amSamlBaseUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/saml2`;
  const entityEndpoint = `${amSamlBaseUrl}/${samlLocation}/${samlId}`;
  emit(`GET ${entityEndpoint}\n`);
  const config = escapePlaceholders((await restGet(entityEndpoint, null, token)).data);

  const metadataUrl = `${tenantUrl}/am/saml2/jsp/exportmetadata.jsp?entityid=${encodeURIComponent(entityId)}&realm=${encodeURIComponent(`/${realm}`)}`;
  emit(`GET ${metadataUrl}\n`);
  let metadata = "";
  try {
    metadata = (await restGet(metadataUrl, null, null)).data;
  } catch (e) {
    emit(`Warning: unable to fetch metadata for ${entityId}: ${e?.message ?? String(e)}\n`);
  }

  const targetName = fileName ?? safeFileNameUnderscore(entityId);
  const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR, samlLocation);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, `${targetName}.json`), JSON.stringify({ config, metadata }, null, 2));
  emit(`  ← ${realm}/${samlLocation}/${targetName}\n`);
}

async function pullDiscoveredProviders({ exportDir, tenantUrl, token, realm, emit }) {
  const amSamlBaseUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/saml2`;
  const queryEndpoint = `${amSamlBaseUrl}?_queryFilter=true&_pageSize=1000`;
  emit(`GET ${queryEndpoint}\n`);
  const query = (await restGet(queryEndpoint, null, token)).data;
  const providers = query.result ?? [];
  if (providers.length === 0) {
    emit(`saml: no entity providers found in realm ${realm}\n`);
    return;
  }

  for (const provider of providers) {
    const entityId = provider.entityId ?? provider._id;
    const samlId = provider._id;
    const samlLocation = provider.location;
    if (!entityId || !samlId || !samlLocation) {
      emit(`Warning: skipping SAML entity with missing id/location in realm ${realm}\n`);
      continue;
    }
    await pullEntity({ exportDir, tenantUrl, token, realm, entityId, samlId, samlLocation, emit });
  }
}

async function pullDiscoveredCirclesOfTrust({ exportDir, tenantUrl, token, realm, emit }) {
  const cotListEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/federation/circlesoftrust?_queryFilter=true&_pageSize=1000`;
  emit(`GET ${cotListEndpoint}\n`);
  let query;
  try {
    query = (await restGet(cotListEndpoint, null, token)).data;
  } catch (e) {
    emit(`Warning: unable to discover circles of trust for realm ${realm}: ${e?.message ?? String(e)}\n`);
    return;
  }
  for (const cotRef of query.result ?? []) {
    const cotName = cotRef._id ?? cotRef.name;
    if (!cotName) continue;
    const cotEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/federation/circlesoftrust/${encodeURIComponent(cotName)}`;
    emit(`GET ${cotEndpoint}\n`);
    try {
      const cot = (await restGet(cotEndpoint, null, token)).data;
      const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR, "COT");
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, `${safeFileNameUnderscore(cotName)}.json`), JSON.stringify(cot, null, 2));
      emit(`  ← ${realm}/COT/${cotName}\n`);
    } catch (e) {
      emit(`Warning: unable to fetch COT ${cotName}: ${e?.message ?? String(e)}\n`);
    }
  }
}

async function pullSaml({ exportDir, tenantUrl, token, descriptorFile, realms, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  if (!descriptorFile || !fs.existsSync(descriptorFile)) {
    const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
    emit(`saml: no descriptor file at ${descriptorFile ?? "(unset)"} — auto-discovering providers\n`);
    for (const realm of realmList) {
      await pullDiscoveredProviders({ exportDir, tenantUrl, token, realm, emit });
      await pullDiscoveredCirclesOfTrust({ exportDir, tenantUrl, token, realm, emit });
    }
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
