/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-secrets.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * IMPORTANT: log statements emit only secret IDs, version numbers, and HTTP
 * verbs/URLs — never secret values or request bodies. Placeholder substitution
 * (${...}) reads from envVars (defaults to process.env). The actual value
 * reaches the tenant via the POST body, which is never logged.
 */

const fs = require("fs");
const path = require("path");
const { restGet, restPut, restPost, restDelete } = require("../common/restClient.js");
const { replaceEnvSpecificValues } = require("../common/config-process.js");

async function pushSecrets({ configDir, tenantUrl, token, name, prune, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "esvs", "secrets");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no secrets config at ${dir}\n`);
    return;
  }

  const secretFiles = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
  let updatesMade = false;

  for (const secretFile of secretFiles) {
    const rawContent = fs.readFileSync(path.join(dir, secretFile), "utf-8");
    // base64Encode=true matches upstream — placeholder values are base64-encoded on substitution.
    const secretObject = JSON.parse(replaceEnvSpecificValues(rawContent, true, envVars));
    if (name && name !== secretObject._id) continue;

    const secretBaseUrl = `${tenantUrl}/environment/secrets/${secretObject._id}`;

    let existingSecret = null;
    try {
      existingSecret = await restGet(secretBaseUrl, null, token, "protocol=1.0,resource=1.0");
    } catch (e) {
      if (e?.response?.status !== 404) throw e;
    }

    if (prune && existingSecret) {
      let versionsResponse = null;
      try {
        versionsResponse = await restGet(`${secretBaseUrl}/versions`, null, token, "protocol=1.0,resource=1.0");
      } catch (e) {
        if (e?.response?.status !== 404) throw e;
      }
      if (versionsResponse) {
        for (const version of versionsResponse.data ?? []) {
          if (version.status === "ENABLED" && version.loaded === false && version.version !== existingSecret.data.activeVersion) {
            await restDelete(`${secretBaseUrl}/versions/${version.version}`, token, "protocol=2.1,resource=1.0");
            emit(`Secret ${secretObject._id} pruned version ${version.version}\n`);
          }
        }
      }
    }

    // Single-value path
    if (secretObject.valueBase64) {
      if (!existingSecret) {
        emit(`PUT ${secretBaseUrl} (create)\n`);
        await restPut(secretBaseUrl, secretObject, token, "protocol=1.0,resource=1.0");
        emit(`Secret ${secretObject._id} created\n`);
        updatesMade = true;
      } else {
        const versionsUrl = `${secretBaseUrl}/versions`;
        emit(`POST ${versionsUrl} (_action=create)\n`);
        const res = await restPost(versionsUrl, { _action: "create" }, secretObject, token, "protocol=1.0,resource=1.0");
        if (res.data.loaded) {
          emit(`Secret ${secretObject._id} unchanged version ${res.data.version}\n`);
        } else {
          emit(`Secret ${secretObject._id} created version ${res.data.version}\n`);
          updatesMade = true;
        }
      }
      continue;
    }

    // Multi-version legacy path
    const versions = (secretObject.versions ?? []).slice().sort((a, b) => Number(a.version) - Number(b.version));
    delete secretObject.versions;

    for (let i = 0; i < versions.length; i++) {
      if (i === 0 && !existingSecret) {
        secretObject.valueBase64 = versions[i].valueBase64;
        emit(`PUT ${secretBaseUrl} (create)\n`);
        await restPut(secretBaseUrl, secretObject, token, "protocol=1.0,resource=1.0");
        emit(`Secret ${secretObject._id} created\n`);
        updatesMade = true;
        continue;
      }
      const versionsUrl = `${secretBaseUrl}/versions`;
      emit(`POST ${versionsUrl} (_action=create, version ${i + 1})\n`);
      const res = await restPost(versionsUrl, { _action: "create" }, { valueBase64: versions[i].valueBase64 }, token, "protocol=1.0,resource=1.0");
      if (res?.data?.loaded) {
        emit(`Secret ${secretObject._id} unchanged version ${res.data.version}\n`);
      } else if (res?.data?.version != null) {
        emit(`Secret ${secretObject._id} created version ${res.data.version}\n`);
        updatesMade = true;
      }
    }
  }

  emit(updatesMade ? "Changes made to secrets\n" : "No changes to secrets\n");
}

module.exports = { pushSecrets };
