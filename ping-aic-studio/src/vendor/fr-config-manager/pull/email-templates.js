/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/emailTemplates.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EMAIL_SUB_DIR = "email-templates";

function splitLangToFile(property, templatePath, templateName, suffix) {
  if (!property) return;
  for (const [language, text] of Object.entries(property)) {
    const filename = `${templateName}.${language}.${suffix}`;
    fs.writeFileSync(path.join(templatePath, filename), text);
    property[language] = { file: filename };
  }
}

async function pullEmailTemplates({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/config`;
  emit(`GET ${idmEndpoint} (email-templates)\n`);
  const response = await restGet(idmEndpoint, { _queryFilter: '_id sw "emailTemplate"' }, token);

  const fileDir = path.join(exportDir, EMAIL_SUB_DIR);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

  for (const template of response.data.result) {
    const templateName = template._id.split("/")[1];
    if (name && name !== templateName) continue;

    const templatePath = path.join(fileDir, templateName);
    if (!fs.existsSync(templatePath)) fs.mkdirSync(templatePath, { recursive: true });

    splitLangToFile(template.html, templatePath, templateName, "html");
    splitLangToFile(template.message, templatePath, templateName, "md");
    if (template.styles) {
      const cssFilename = `${templateName}.css`;
      fs.writeFileSync(path.join(templatePath, cssFilename), template.styles);
      template.styles = { file: cssFilename };
    }

    fs.writeFileSync(path.join(templatePath, `${templateName}.json`), JSON.stringify(template, null, 2));
    emit(`  ← ${templateName}\n`);
  }
}

module.exports = { pullEmailTemplates };
