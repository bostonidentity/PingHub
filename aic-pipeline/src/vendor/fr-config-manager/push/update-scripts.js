/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-scripts.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Takes configDir / tenantUrl / realms / name / token / log as args instead
 *     of env + argv.
 *   - await'd the previously-unawaited pushScript call in the for loop so
 *     failures surface and ordering is deterministic.
 *   - Dropped uglify-js import (unused in upstream), lodash.isEqual, and the
 *     UPDATE_CHANGED_ONLY short-circuit.
 *   - Replaced process.exit(1) with throw.
 *   - Dropped linting warnings (informational only).
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushScript(script, dir, tenantBaseUrl, realm, token, emit) {
  const sourcePath = path.join(dir, script.script.file);
  const originalScript = fs.readFileSync(sourcePath, { encoding: "utf-8" });

  script.script = Buffer.from(originalScript).toString("base64");
  delete script.createdBy;
  delete script.creationDate;
  delete script.lastModifiedBy;
  delete script.lastModifiedDate;

  if (script.description === null) script.description = "";

  const requestUrl = `${tenantBaseUrl}/am/json/realms/root/realms/${realm}/scripts/${script._id}`;
  emit(`PUT ${requestUrl}\n`);
  await restPut(requestUrl, script, token, "protocol=2.0,resource=1.0");
}

async function updateScripts({ configDir, tenantUrl, realms, name, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  if (name && realmList.length !== 1) {
    throw new Error("for a named script, specify a single realm");
  }

  let scriptNotFound = !!name;

  for (const realm of realmList) {
    const baseDir = path.join(configDir, "realms", realm, "scripts");
    const scriptConfigDir = path.join(baseDir, "scripts-config");
    if (!fs.existsSync(scriptConfigDir)) {
      emit(`Warning: no script config for realm ${realm} at ${scriptConfigDir}\n`);
      continue;
    }

    const configFiles = fs
      .readdirSync(scriptConfigDir)
      .filter((n) => path.extname(n) === ".json");

    for (const filename of configFiles) {
      const script = JSON.parse(
        fs.readFileSync(path.join(scriptConfigDir, filename), "utf-8"),
      );
      if (!script.name || script.name.trim() === "") {
        throw new Error(`script id ${script._id} must have a non-blank name`);
      }
      if (name && script.name !== name) continue;
      scriptNotFound = false;
      await pushScript(script, baseDir, tenantUrl, realm, token, emit);
    }
  }

  if (name && scriptNotFound) {
    throw new Error(`script "${name}" not found under ${configDir}`);
  }
}

async function pushScriptById({ configDir, scriptId, tenantUrl, realm, token, log }) {
  const emit = typeof log === "function" ? log : () => {};
  const baseDir = path.join(configDir, "realms", realm, "scripts");
  const configFile = path.join(baseDir, "scripts-config", `${scriptId}.json`);
  if (!fs.existsSync(configFile)) {
    throw new Error(`script ${scriptId} not found at ${configFile}`);
  }
  const script = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  await pushScript(script, baseDir, tenantUrl, realm, token, emit);
}

module.exports = { updateScripts, pushScriptById };
