/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/customNodes.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes:
 *   - revertLibraryReferences inlined (tiny helper; not worth a separate file).
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const CUSTOM_NODES_SUBDIR = "custom-nodes";

function revertLibraryReferences(source) {
  const lines = source.split("\n");
  const revertedLines = [];
  const importBeginRegex = /^\s*\/\/\/\s*@import-begin\s+<reference\s+path="([^"]+)"\s*\/>\s*$/;
  const importEndRegex = /^\s*\/\/\/\s*@import-end\s*$/;
  let skipping = false;
  let currentRefPath = null;

  for (const line of lines) {
    if (!skipping) {
      const match = line.match(importBeginRegex);
      if (match) {
        skipping = true;
        currentRefPath = match[1];
        revertedLines.push(`/// <reference path="${currentRefPath}" />`);
        continue;
      }
    } else if (importEndRegex.test(line)) {
      skipping = false;
      currentRefPath = null;
      continue;
    }
    if (!skipping) revertedLines.push(line);
  }
  return revertedLines.join("\n");
}

function saveScriptToFile(node, nodeExportDir) {
  const scriptFilename = `${node.displayName}.js`;
  let source = node.script;
  source = revertLibraryReferences(source);
  source = source.replace(/\\n/, "\n");
  fs.writeFileSync(path.join(nodeExportDir, scriptFilename), source);
  node.script = { file: scriptFilename };
}

async function pullCustomNodes({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const amEndpoint = `${tenantUrl}/am/json/node-designer/node-type`;
  emit(`GET ${amEndpoint}\n`);
  const response = await restGet(amEndpoint, { _queryFilter: "true" }, token);
  const nodes = response.data.result;

  const fileDir = path.join(exportDir, CUSTOM_NODES_SUBDIR, "nodes");
  let nodeFound = false;

  for (const node of nodes) {
    const nodeName = node.displayName;
    const exportSubDir = path.join(fileDir, nodeName);
    if (!fs.existsSync(exportSubDir)) fs.mkdirSync(exportSubDir, { recursive: true });
    if (name && name !== nodeName) continue;
    nodeFound = true;

    saveScriptToFile(node, exportSubDir);
    fs.writeFileSync(path.join(exportSubDir, `${nodeName}.json`), JSON.stringify(node, null, 2));
    emit(`  ← ${nodeName}\n`);
  }

  if (name && !nodeFound) emit(`Custom node not found: ${name}\n`);
}

module.exports = { pullCustomNodes };
