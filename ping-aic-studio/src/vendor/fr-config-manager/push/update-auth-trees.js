/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-auth-trees.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Takes configDir / tenantUrl / realms / name / pushInnerJourneys /
 *     pushScripts / token / log as args instead of env + argv.
 *   - Throws on "No journeys found" and other errors instead of process.exit(1).
 *   - Replaced the `glob` dependency with fs.readdir walks.
 *   - Inlined journeyNodeNeedsScript from upstream utils.js.
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");
const { pushScriptById } = require("./update-scripts.js");

const INNER_TREE_ID = "InnerTreeEvaluatorNode";

function journeyNodeNeedsScript(node) {
  return (
    Object.prototype.hasOwnProperty.call(node, "script") &&
    (!Object.prototype.hasOwnProperty.call(node, "useScript") || node.useScript)
  );
}

function topLevelJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name);
}

function nestedJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(dir, sub.name);
    for (const f of fs.readdirSync(subPath, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".json")) {
        out.push(path.join(sub.name, f.name));
      }
    }
  }
  return out;
}

async function pushNode(baseUrl, node, token, emit) {
  const nodeRequestUrl = `${baseUrl}/nodes/${node._type._id}/${node._id}`;
  delete node._rev;
  if (emit) emit(`  PUT ${nodeRequestUrl}\n`);
  await restPut(nodeRequestUrl, node, token, "protocol=2.1,resource=1.0");
}

async function pushJourney(journey, baseUrl, token, emit) {
  delete journey._rev;
  const requestUrl = `${baseUrl}/trees/${journey._id}`;
  if (emit) emit(`  PUT ${requestUrl}\n`);
  await restPut(requestUrl, journey, token, "protocol=2.1,resource=1.0");
}

async function handleNodes(ctx, nodeDir, fileList) {
  const { baseUrl, configDir, tenantUrl, realm, pushInnerJourneys, pushScripts, token, emit } = ctx;
  for (const nodeFile of fileList) {
    const node = JSON.parse(fs.readFileSync(path.join(nodeDir, nodeFile), "utf-8"));
    if (node._type._id === INNER_TREE_ID && pushInnerJourneys) {
      const innerName = node.tree;
      await handleJourney(ctx, `${innerName}/${innerName}.json`);
    } else if (pushScripts && journeyNodeNeedsScript(node)) {
      await pushScriptById({ configDir, scriptId: node.script, tenantUrl, realm, token, log: emit });
    }
    await pushNode(baseUrl, node, token, emit);
  }
}

async function handleJourney(ctx, journeyFile) {
  const { configDir, realm, journeysProcessed, tenantUrl, token, emit } = ctx;
  const dir = path.join(configDir, "realms", realm, "journeys");
  const journeyFullPath = path.join(dir, journeyFile);
  if (journeysProcessed.has(journeyFullPath)) return;
  journeysProcessed.add(journeyFullPath);

  if (!fs.existsSync(journeyFullPath)) {
    emit(`warning: journey file missing: ${journeyFullPath}\n`);
    return;
  }

  const journey = JSON.parse(fs.readFileSync(journeyFullPath, "utf-8"));
  const baseUrl = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees`;
  const journeyDir = path.dirname(journeyFile);
  const nodeDir = path.join(dir, journeyDir, "nodes");

  emit(`Pushing journey ${realm}/${journey._id}\n`);

  const childCtx = { ...ctx, baseUrl };
  await handleNodes(childCtx, nodeDir, nestedJsonFiles(nodeDir));
  await handleNodes(childCtx, nodeDir, topLevelJsonFiles(nodeDir));
  await pushJourney(journey, baseUrl, token, emit);
}

async function updateAuthTrees({ configDir, tenantUrl, realms, name, pushInnerJourneys, pushScripts, token, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};

  if (name && realmList.length !== 1) {
    throw new Error("for a named journey, specify a single realm");
  }

  const pushInner = name ? !!pushInnerJourneys : true;
  const pushScr = !!pushScripts;

  emit(`${name ? `Updating journey "${name}"` : "Updating journeys"}${pushInner ? " including inner journeys" : ""}${pushScr ? " and scripts" : ""}\n`);

  const journeysProcessed = new Set();

  for (const realm of realmList) {
    const journeyBaseDir = path.join(configDir, "realms", realm, "journeys");
    if (!fs.existsSync(journeyBaseDir)) {
      emit(`Warning: no journey config for realm ${realm} at ${journeyBaseDir}\n`);
      continue;
    }

    const journeyFiles = [];
    if (name) {
      const namedDir = path.join(journeyBaseDir, name);
      if (fs.existsSync(namedDir) && fs.statSync(namedDir).isDirectory()) {
        for (const f of fs.readdirSync(namedDir)) {
          if (f.endsWith(".json")) journeyFiles.push(path.join(name, f));
        }
      }
    } else {
      for (const sub of fs.readdirSync(journeyBaseDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const subPath = path.join(journeyBaseDir, sub.name);
        for (const f of fs.readdirSync(subPath)) {
          if (f.endsWith(".json")) journeyFiles.push(path.join(sub.name, f));
        }
      }
    }

    if (journeyFiles.length === 0) {
      throw new Error(`No journeys found under ${journeyBaseDir}${name ? ` for name "${name}"` : ""}`);
    }

    const ctx = {
      configDir,
      tenantUrl,
      realm,
      pushInnerJourneys: pushInner,
      pushScripts: pushScr,
      journeysProcessed,
      token,
      emit,
    };
    for (const journeyFile of journeyFiles) {
      await handleJourney(ctx, journeyFile);
    }
  }
}

module.exports = { updateAuthTrees };
