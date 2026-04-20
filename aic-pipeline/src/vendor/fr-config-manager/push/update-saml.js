/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-saml.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet, restPut, restPost } = require("../common/restClient.js");
const { replaceEnvSpecificValues } = require("../common/config-process.js");

const API = "protocol=2.0,resource=1.0";

async function getSamlEntity(amSamlBaseUrl, entityId, token) {
  const endpoint = `${amSamlBaseUrl}?_queryFilter=entityId%20eq%20'${encodeURIComponent(entityId)}'`;
  const res = await restGet(endpoint, null, token);
  return res?.data;
}

async function handleHostedEntity(samlObject, amSamlBaseUrl, token, emit) {
  const fileContent = { ...samlObject.config };
  delete fileContent._rev;
  const entityId = fileContent.entityId;
  const query = await getSamlEntity(amSamlBaseUrl, entityId, token);

  if (query.resultCount === 1) {
    const url = `${amSamlBaseUrl}/hosted/${fileContent._id}`;
    emit(`PUT ${url}\n`);
    await restPut(url, fileContent, token, API);
  } else if (query.resultCount === 0) {
    const url = `${amSamlBaseUrl}/hosted`;
    emit(`POST ${url} (_action=create)\n`);
    await restPost(url, { _action: "create" }, fileContent, token, API);
  } else {
    throw new Error(`Ambiguous lookup for hosted SAML entity ${entityId} (${query.resultCount} matches)`);
  }
}

async function handleRemoteEntity(samlObject, amSamlBaseUrl, token, emit) {
  const fileContent = { ...samlObject.config };
  delete fileContent._rev;
  const entityId = fileContent.entityId;
  const query = await getSamlEntity(amSamlBaseUrl, entityId, token);

  if (query.resultCount === 0) {
    const encoded = Buffer.from(samlObject.metadata, "utf-8").toString("base64url");
    const importUrl = `${amSamlBaseUrl}/remote`;
    emit(`POST ${importUrl} (_action=importEntity)\n`);
    await restPost(importUrl, { _action: "importEntity" }, { standardMetadata: encoded }, token, API);
  }

  const updateUrl = `${amSamlBaseUrl}/remote/${fileContent._id}`;
  emit(`PUT ${updateUrl}\n`);
  await restPut(updateUrl, fileContent, token, API);
}

async function handleCot(samlObject, tenantUrl, realm, token, emit) {
  delete samlObject._rev;
  const cotName = samlObject._id;
  const url = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/federation/circlesoftrust/${cotName}`;
  emit(`PUT ${url}\n`);
  await restPut(url, samlObject, token, API);
}

async function pushSaml({ configDir, tenantUrl, realms, token, name, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  if (name && realmList.length !== 1) {
    throw new Error("for a named SAML entity, specify a single realm");
  }

  for (const realm of realmList) {
    const baseDir = path.join(configDir, "realms", realm, "realm-config", "saml");
    if (!fs.existsSync(baseDir)) {
      emit(`Warning: no SAML config for realm ${realm}\n`);
      continue;
    }

    const amSamlBaseUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/saml2`;

    const samlTypes = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const samlType of samlTypes) {
      if (samlType.toLowerCase() === "cot") continue; // handled separately below
      const subDir = path.join(baseDir, samlType);
      const samlFiles = fs.readdirSync(subDir).filter((n) => path.extname(n) === ".json");

      for (const samlFile of samlFiles) {
        const rawContent = fs.readFileSync(path.join(subDir, samlFile), "utf-8");
        const resolved = replaceEnvSpecificValues(rawContent, false, envVars);
        const samlObject = JSON.parse(resolved);

        if (name) {
          const configId = samlObject?.config?._id;
          const configEntityId = samlObject?.config?.entityId;
          if (configId !== name && configEntityId !== name && samlObject?._id !== name) continue;
        }

        switch (samlType.toLowerCase()) {
          case "remote":
            await handleRemoteEntity(samlObject, amSamlBaseUrl, token, emit);
            break;
          case "hosted":
            await handleHostedEntity(samlObject, amSamlBaseUrl, token, emit);
            break;
          default:
            throw new Error(`Unknown SAML type: ${samlType}`);
        }
      }
    }

    const cotDir = path.join(baseDir, "COT");
    if (fs.existsSync(cotDir)) {
      const samlFiles = fs.readdirSync(cotDir).filter((n) => path.extname(n) === ".json");
      for (const samlFile of samlFiles) {
        const rawContent = fs.readFileSync(path.join(cotDir, samlFile), "utf-8");
        const resolved = replaceEnvSpecificValues(rawContent, false, envVars);
        const samlObject = JSON.parse(resolved);
        await handleCot(samlObject, tenantUrl, realm, token, emit);
      }
    }
  }
}

module.exports = { pushSaml };
