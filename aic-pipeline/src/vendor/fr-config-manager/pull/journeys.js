/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/journeys.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Accepts exportDir / tenantUrl / realms / name / pullDependencies / clean /
 *     token / log as arguments instead of reading process.env.
 *   - Awaits previously-unawaited async calls (exportScriptById, recursive
 *     processJourneys) so script dep pull and inner-journey pull complete
 *     deterministically instead of racing.
 *   - journeyCache scoped per-call via Set instead of module-level array.
 *   - saveJsonToFile / safeFileName / journeyNodeNeedsScript inlined from
 *     upstream utils.js.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");
const { exportScriptById } = require("./scripts.js");

const JOURNEY_SUB_DIR = "journeys";
const NODES_SUB_DIR = "nodes";

function saveJsonToFile(data, filename) {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
}

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function journeyNodeNeedsScript(node) {
  return (
    Object.prototype.hasOwnProperty.call(node, "script") &&
    (!Object.prototype.hasOwnProperty.call(node, "useScript") || node.useScript)
  );
}

function fileNameFromNode(displayName, id) {
  return safeFileName(`${displayName} - ${id}`);
}

async function cacheNodesByType(nodeCache, nodeType, tenantUrl, realm, token) {
  if (nodeCache[nodeType]) return nodeCache;
  const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees/nodes/${nodeType}`;
  const response = await restGet(amEndpoint, { _queryFilter: "true" }, token);
  nodeCache[nodeType] = response.data.result;
  return nodeCache;
}

async function processJourneys(ctx) {
  const { journeys, realm, name, pullDependencies, tenantUrl, token, exportDir, clean, journeyCache, emit } = ctx;
  const fileDir = path.join(exportDir, realm, JOURNEY_SUB_DIR);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

  let nodeCache = {};
  for (const journey of journeys) {
    if (name && journey._id !== name) continue;
    if (journeyCache.has(journey._id)) continue;
    journeyCache.add(journey._id);

    const journeyDir = path.join(fileDir, safeFileName(journey._id));
    const nodeDir = path.join(journeyDir, NODES_SUB_DIR);
    if (clean) fs.rmSync(nodeDir, { recursive: true, force: true });
    if (!fs.existsSync(nodeDir)) fs.mkdirSync(nodeDir, { recursive: true });

    emit(`  ← ${realm}/${journey._id}\n`);

    for (const [nodeId, nodeInfo] of Object.entries(journey.nodes)) {
      const nodeType = nodeInfo.nodeType;
      nodeCache = await cacheNodesByType(nodeCache, nodeType, tenantUrl, realm, token);
      const node = nodeCache[nodeType].find(({ _id }) => _id === nodeId);
      if (!node) {
        emit(`warning: node ${nodeId} (${nodeType}) not found in realm ${realm}\n`);
        continue;
      }

      const nodeFileNameRoot = path.join(nodeDir, fileNameFromNode(nodeInfo.displayName, nodeId));

      if (node._type._id === "PageNode") {
        if (!fs.existsSync(nodeFileNameRoot)) fs.mkdirSync(nodeFileNameRoot, { recursive: true });
        for (const subNode of node.nodes) {
          nodeCache = await cacheNodesByType(nodeCache, subNode.nodeType, tenantUrl, realm, token);
          const subNodeSpec = nodeCache[subNode.nodeType].find(({ _id }) => _id === subNode._id);
          if (!subNodeSpec) {
            emit(`warning: subnode ${subNode._id} not found for PageNode ${nodeId}\n`);
            continue;
          }
          const subNodeFilename = path.join(nodeFileNameRoot, `${fileNameFromNode(subNode.displayName, subNodeSpec._id)}.json`);
          saveJsonToFile(subNodeSpec, subNodeFilename);
          if (pullDependencies && journeyNodeNeedsScript(subNodeSpec)) {
            await exportScriptById({ exportDir, tenantUrl, realm, id: subNodeSpec.script, token });
          }
        }
      } else if (pullDependencies && journeyNodeNeedsScript(node)) {
        await exportScriptById({ exportDir, tenantUrl, realm, id: node.script, token });
      } else if (!!name && pullDependencies && node._type._id === "InnerTreeEvaluatorNode") {
        await processJourneys({ ...ctx, name: node.tree });
      }

      saveJsonToFile(node, `${nodeFileNameRoot}.json`);
    }

    saveJsonToFile(journey, path.join(journeyDir, `${journey._id}.json`));
  }
}

async function exportJourneys({ exportDir, tenantUrl, realms, name, pullDependencies, clean, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const realmList = Array.isArray(realms) && realms.length > 0 ? realms : ["alpha"];
  const emit = typeof log === "function" ? log : () => {};
  const journeyCache = new Set();

  for (const realm of realmList) {
    const amEndpoint = `${tenantUrl}/am/json/realms/root/realms/${realm}/realm-config/authentication/authenticationtrees/trees?_queryFilter=true`;
    const response = await restGet(amEndpoint, null, token);
    const journeys = response.data.result;
    emit(`Pulling ${journeys.length} journey(s) from ${realm}${name ? ` (filter: ${name})` : ""}\n`);
    await processJourneys({ journeys, realm, name, pullDependencies: !!pullDependencies, tenantUrl, token, exportDir, clean: !!clean, journeyCache, emit });
  }
}

module.exports = { exportJourneys };
