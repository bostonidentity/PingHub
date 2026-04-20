/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-policies.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet, restPut, restPost } = require("../common/restClient.js");

function clearOperationalAttributes(obj) {
  delete obj._id;
  delete obj._rev;
  delete obj.createdBy;
  delete obj.creationDate;
  delete obj.lastModifiedBy;
  delete obj.lastModifiedDate;
}

async function alreadyExists(requestUrl, token) {
  try {
    await restGet(requestUrl, null, token);
    return true;
  } catch (e) {
    if (e?.response?.status === 404) return false;
    throw e;
  }
}

async function upsertResource(basePath, resourceName, resourceObject, apiVersion, token, emit) {
  const requestUrl = `${basePath}/${encodeURIComponent(resourceName)}`;
  if (await alreadyExists(requestUrl, token)) {
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, resourceObject, token, apiVersion);
  } else {
    emit(`POST ${basePath} (_action=create) ${resourceName}\n`);
    await restPost(basePath, { _action: "create" }, resourceObject, token, apiVersion);
  }
}

async function pushAuthzPolicies({ configDir, tenantUrl, realms, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const baseDir = path.join(configDir, "realms", realm, "authorization");
    if (!fs.existsSync(baseDir)) {
      emit(`Warning: no authz-policies config for realm ${realm}\n`);
      continue;
    }

    const resourceTypesDir = path.join(baseDir, "resource-types");
    if (fs.existsSync(resourceTypesDir)) {
      for (const resourceType of fs.readdirSync(resourceTypesDir)) {
        const rt = JSON.parse(fs.readFileSync(path.join(resourceTypesDir, resourceType), "utf-8"));
        rt.uuid = rt._id;
        delete rt._id;
        clearOperationalAttributes(rt);
        const resourcePath = `${tenantUrl}/am/json/${realm}/resourcetypes`;
        await upsertResource(resourcePath, rt.uuid, rt, "protocol=1.0,resource=1.0", token, emit);
      }
    }

    const policySetsDir = path.join(baseDir, "policy-sets");
    if (!fs.existsSync(policySetsDir)) continue;

    for (const policySetDir of fs.readdirSync(policySetsDir)) {
      const policySetFile = path.join(policySetsDir, policySetDir, `${policySetDir}.json`);
      if (!fs.existsSync(policySetFile)) continue;
      const policySet = JSON.parse(fs.readFileSync(policySetFile, "utf-8"));
      clearOperationalAttributes(policySet);

      const resourcePath = `${tenantUrl}/am/json/${realm}/applications`;
      await upsertResource(resourcePath, policySet.name, policySet, "protocol=1.0,resource=2.0", token, emit);

      const policiesDir = path.join(policySetsDir, policySetDir, "policies");
      if (!fs.existsSync(policiesDir)) continue;

      for (const policyFile of fs.readdirSync(policiesDir)) {
        const policy = JSON.parse(fs.readFileSync(path.join(policiesDir, policyFile), "utf-8"));
        clearOperationalAttributes(policy);
        const policiesPath = `${tenantUrl}/am/json/realms/root/realms/${realm}/policies`;
        await upsertResource(policiesPath, policy.name, policy, "protocol=1.0,resource=2.0", token, emit);
      }
    }
  }
}

module.exports = { pushAuthzPolicies };
