/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/authzPolicies.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Pull requires a descriptor file listing { realm: [policySet1, policySet2, ...] }.
 * Skips gracefully if no descriptor provided.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "authorization";

async function saveResourceType(exportDir, resourceTypeUuid, realm, tenantUrl, token) {
  const resourceTypeDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR, "resource-types");
  if (!fs.existsSync(resourceTypeDir)) fs.mkdirSync(resourceTypeDir, { recursive: true });

  const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/resourcetypes/${resourceTypeUuid}`;
  const response = await restGet(amEndpoint, null, token);
  const resourceType = response.data;
  fs.writeFileSync(path.join(resourceTypeDir, `${resourceType.name}.json`), JSON.stringify(resourceType, null, 2));
}

async function exportPolicies(exportDir, targetDir, realm, policySet, tenantUrl, token, emit) {
  const log = typeof emit === "function" ? emit : () => {};
  const policyDir = path.join(targetDir, "policies");
  if (!fs.existsSync(policyDir)) fs.mkdirSync(policyDir, { recursive: true });

  const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/policies`;
  const response = await restGet(amEndpoint, { _queryFilter: `applicationName eq "${policySet}"` }, token);

  for (const policy of response.data.result) {
    fs.writeFileSync(path.join(policyDir, `${policy.name}.json`), JSON.stringify(policy, null, 2));
    log(`    ← policy ${policy.name}\n`);
    if (policy.resourceTypeUuid) {
      await saveResourceType(exportDir, policy.resourceTypeUuid, realm, tenantUrl, token);
    }
  }
}

async function pullAuthzPolicies({ exportDir, tenantUrl, token, descriptorFile, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  if (!descriptorFile || !fs.existsSync(descriptorFile)) {
    emit(`authz-policies: no descriptor file at ${descriptorFile ?? "(unset)"} — skipping\n`);
    return;
  }

  const policySets = JSON.parse(fs.readFileSync(descriptorFile, "utf-8"));
  for (const realm of Object.keys(policySets)) {
    for (const policySet of policySets[realm]) {
      const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/applications/${policySet}`;
      emit(`GET ${amEndpoint}\n`);
      const response = await restGet(amEndpoint, null, token);

      const targetDir = path.join(exportDir, "realms", realm, EXPORT_SUBDIR, "policy-sets", policySet);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, `${policySet}.json`), JSON.stringify(response.data, null, 2));
      emit(`  ← ${realm}/policy-sets/${policySet}\n`);

      await exportPolicies(exportDir, targetDir, realm, policySet, tenantUrl, token, emit);
    }
  }
}

module.exports = { pullAuthzPolicies };
