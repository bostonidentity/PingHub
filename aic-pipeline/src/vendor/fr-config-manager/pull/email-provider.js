/*
 * No upstream pull script for email-provider; this is the dual of
 * update-email-provider.js (which reads external.email.json).
 * Pulls GET /openidm/config/external.email and writes to email-provider/external.email.json.
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

async function pullEmailProvider({ exportDir, tenantUrl, token, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const endpoint = `${tenantUrl}/openidm/config/external.email`;
  emit(`GET ${endpoint}\n`);
  const response = await restGet(endpoint, null, token);

  const dir = path.join(exportDir, "email-provider");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "external.email.json"), JSON.stringify(response.data, null, 2));
  emit(`  ← external.email.json\n`);
}

module.exports = { pullEmailProvider };
