/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-custom-nodes.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter changes:
 *   - expandLibraryReferences inlined.
 *   - Replaced glob dep with fs.readdir walk.
 *   - Dropped fileFilter helper.
 */

const fs = require("fs");
const path = require("path");
const { restUpsert } = require("../common/restClient.js");

function expandLibraryReferences(source, libPath) {
  const lines = source.split("\n");
  const expandedLines = [];
  const referenceRegex = /^\s*\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>\s*$/;

  for (const line of lines) {
    const match = line.match(referenceRegex);
    if (match) {
      const refPath = match[1];
      const fullRefPath = path.join(libPath, refPath);
      if (!fs.existsSync(fullRefPath)) {
        throw new Error(`custom-node library reference not found: ${fullRefPath}`);
      }
      const refContent = fs.readFileSync(fullRefPath, "utf-8");
      expandedLines.push(`/// @import-begin <reference path="${refPath}" />`);
      expandedLines.push(...refContent.split("\n"));
      expandedLines.push("/// @import-end");
    } else {
      expandedLines.push(line);
    }
  }
  return expandedLines.join("\n");
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

async function pushCustomNodes({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const baseDir = path.join(configDir, "custom-nodes");
  const nodeDir = path.join(baseDir, "nodes");
  if (!fs.existsSync(baseDir)) {
    emit(`Warning: no custom-nodes config at ${baseDir}\n`);
    return;
  }

  const jsonFiles = nestedJsonFiles(nodeDir);
  let nodeFound = !name;

  for (const jsonFile of jsonFiles) {
    const node = JSON.parse(fs.readFileSync(path.join(nodeDir, jsonFile), "utf-8"));
    const nodeName = node.displayName;
    if (name && name !== nodeName) continue;
    nodeFound = true;

    const nodeSubDir = path.dirname(jsonFile);
    const nodeFullDir = path.join(nodeDir, nodeSubDir);
    const scriptSource = fs.readFileSync(path.join(nodeFullDir, node.script.file), "utf-8");
    node.script = expandLibraryReferences(scriptSource, nodeFullDir);
    delete node._rev;

    const requestUrl = `${tenantUrl}/am/json/node-designer/node-type/${node._id}`;
    emit(`UPSERT ${requestUrl}\n`);
    await restUpsert(requestUrl, node, token, "protocol=2.0,resource=1.0");
  }

  if (name && !nodeFound) {
    throw new Error(`custom node "${name}" not found under ${nodeDir}`);
  }
}

module.exports = { pushCustomNodes };
