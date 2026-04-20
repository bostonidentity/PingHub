/*
 * In-process OIDC providers push — replaces `frodo idp import -A`.
 *
 * Each file is a descendent of the SocialIdentityProviders service. Upsert
 * per provider via our restUpsert helper (GET → PUT If-Match:* or
 * If-None-Match:*).
 */

const fs = require("fs");
const path = require("path");
const { restUpsert } = require("../common/restClient.js");
const { replaceEnvSpecificValues } = require("../common/config-process.js");

async function pushOidcProviders({ configDir, tenantUrl, token, realms, name, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const dir = path.join(configDir, "realms", realm, "idp");
    if (!fs.existsSync(dir)) {
      emit(`Warning: no oidc-providers config for realm ${realm}\n`);
      continue;
    }

    const files = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const resolved = replaceEnvSpecificValues(raw, false, envVars);
      const provider = JSON.parse(resolved);
      const providerId = provider._id ?? path.basename(file, ".json");
      if (name && name !== providerId) continue;
      delete provider._rev;

      const providerType = provider._type?._id;
      if (!providerType) {
        emit(`Warning: ${file} missing _type._id; skipping\n`);
        continue;
      }

      const url = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/services/SocialIdentityProviders/${providerType}/${providerId}`;
      emit(`UPSERT ${url}\n`);
      await restUpsert(url, provider, token, "protocol=2.0,resource=1.0");
    }
  }
}

module.exports = { pushOidcProviders };
