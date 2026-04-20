/*
 * In-process ESV variables push — replaces `frodo esv variable import -A`.
 *
 * Log hygiene: emits only variable IDs + HTTP verbs. Does NOT log the body
 * (valueBase64 may be sensitive).
 */

const fs = require("fs");
const path = require("path");
const { restGet, restPut, restPost } = require("../common/restClient.js");
const { replaceEnvSpecificValues } = require("../common/config-process.js");

async function pushVariables({ configDir, tenantUrl, token, name, envVars, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "esvs", "variables");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no variables config at ${dir}\n`);
    return;
  }

  const files = fs.readdirSync(dir).filter((n) => path.extname(n) === ".json");
  for (const file of files) {
    const rawContent = fs.readFileSync(path.join(dir, file), "utf-8");
    const resolved = replaceEnvSpecificValues(rawContent, false, envVars);
    const doc = JSON.parse(resolved);
    if (name && name !== doc._id) continue;

    const url = `${tenantUrl}/environment/variables/${doc._id}`;

    // Create-or-update: GET existing, PUT (with If-Match:*) if present, else
    // POST _action=create.
    let existing = null;
    try {
      existing = await restGet(url, null, token);
    } catch (e) {
      if (e?.response?.status !== 404) throw e;
    }

    if (existing) {
      emit(`PUT ${url}\n`);
      await restPut(url, doc, token, undefined, "*");
    } else {
      emit(`POST ${tenantUrl}/environment/variables (_action=create, id=${doc._id})\n`);
      await restPost(`${tenantUrl}/environment/variables`, { _action: "create" }, doc, token);
    }
  }
}

module.exports = { pushVariables };
