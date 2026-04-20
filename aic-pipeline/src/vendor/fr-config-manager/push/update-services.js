/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-services.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter changes:
 *   - LOCAL PATCH: descendant push loop is properly awaited. Upstream uses
 *     `descendentsFileContent.map(async ...)` without awaiting, so descendants
 *     may not finish before the outer Promise.all resolves.
 */

const fs = require("fs");
const path = require("path");
const { restPut, restUpsert } = require("../common/restClient.js");

const SOCIAL_IDENTITY_PROVIDER_SERVICE = "SocialIdentityProviders";

async function pushServices({ configDir, tenantUrl, realms, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  if (name && realmList.length !== 1) {
    throw new Error("for a named service, specify a single realm");
  }

  for (const realm of realmList) {
    const dir = path.join(configDir, "realms", realm, "services");
    if (!fs.existsSync(dir)) {
      emit(`Warning: no services config for realm ${realm}\n`);
      continue;
    }

    const serviceFiles = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
    for (const filename of serviceFiles) {
      const serviceFile = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf-8"));
      const serviceName = serviceFile._type?._id;
      if (name && name !== serviceName) continue;
      delete serviceFile._rev;

      const requestUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/services/${serviceName}`;
      emit(`UPSERT ${requestUrl}\n`);
      await restUpsert(requestUrl, serviceFile, token, "protocol=2.0,resource=1.0");

      const descendentsDir = path.join(dir, serviceName);
      if (!fs.existsSync(descendentsDir)) continue;

      const descendentFiles = fs.readdirSync(descendentsDir).filter((n) => path.extname(n) === ".json");
      for (const descFilename of descendentFiles) {
        const descendent = JSON.parse(fs.readFileSync(path.join(descendentsDir, descFilename), "utf-8"));
        if (serviceName === SOCIAL_IDENTITY_PROVIDER_SERVICE && !descendent.redirectAfterFormPostURI) {
          descendent.redirectAfterFormPostURI = "";
        }
        delete descendent._rev;
        const descendentType = descendent._type?._id;
        const descUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/services/${serviceName}/${descendentType}/${descendent._id}`;
        emit(`PUT ${descUrl}\n`);
        await restPut(descUrl, descendent, token, "protocol=2.0,resource=1.0");
      }
    }
  }
}

module.exports = { pushServices };
