/*
 * In-process ESV variables pull — replaces the frodo CLI invocation
 * `frodo esv variable export -A`. Uses IDM's /environment/variables endpoint
 * directly; pulls metadata + base64-encoded values per-variable.
 *
 * Values are stored as literal base64 on disk — matches the round-trip the
 * push expects and mirrors how secrets are handled.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const SUBDIR = "esvs/variables";

async function pullVariables({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const endpoint = `${tenantUrl}/environment/variables`;
  emit(`GET ${endpoint}\n`);
  const res = await restGet(endpoint, { _queryFilter: "true" }, token);
  const variables = res.data.result ?? [];

  const targetDir = path.join(exportDir, SUBDIR);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const matching = name ? variables.filter((v) => v._id === name) : variables;
  emit(`Writing ${matching.length} variable${matching.length === 1 ? "" : "s"}\n`);

  for (const variable of matching) {
    const { _id, description, expressionType, valueBase64 } = variable;
    const doc = { _id, description, expressionType, valueBase64 };
    fs.writeFileSync(path.join(targetDir, `${_id}.json`), JSON.stringify(doc, null, 2));
    emit(`  ← ${_id}\n`);
  }
}

module.exports = { pullVariables };
