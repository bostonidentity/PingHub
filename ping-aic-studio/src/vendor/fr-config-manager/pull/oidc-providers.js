/*
 * In-process External OIDC identity providers pull — replaces
 * `frodo idp export -A`. Social identity providers live under
 * /am/json/realms/root/realms/<realm>/realm-config/services/SocialIdentityProviders.
 * We use restPost with _action=nextdescendents to get every provider type
 * descriptor at once (same pattern as services pull).
 */

const fs = require("fs");
const path = require("path");
const { restPost } = require("../common/restClient.js");

const SUBDIR = "idp";

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

async function pullOidcProviders({ exportDir, tenantUrl, token, realms, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  for (const realm of realmList) {
    const servicesBase = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/services/SocialIdentityProviders`;
    emit(`POST ${servicesBase} (nextdescendents)\n`);
    // restPost 5-arg form: url, params, data, token, apiVersion
    let res;
    try {
      res = await restPost(servicesBase, { _action: "nextdescendents" }, null, token, "protocol=1.0,resource=1.0");
    } catch (err) {
      // AIC returns 400 when SocialIdentityProviders has no configured descendents
      if (err && err.response && err.response.status === 400) {
        emit(`  ℹ no OIDC providers to export in realm ${realm}\n`);
        continue;
      }
      throw err;
    }
    const providers = res.data.result ?? [];

    const targetDir = path.join(exportDir, "realms", realm, SUBDIR);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    for (const provider of providers) {
      const providerId = provider._id;
      if (name && name !== providerId) continue;
      fs.writeFileSync(
        path.join(targetDir, `${providerId}.json`),
        JSON.stringify(escapePlaceholders(provider), null, 2),
      );
      emit(`  ← ${realm}/${providerId}\n`);
    }
  }
}

module.exports = { pullOidcProviders };
