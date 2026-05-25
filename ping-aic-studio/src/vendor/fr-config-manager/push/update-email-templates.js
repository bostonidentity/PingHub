/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-email-templates.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

function mergeFileContent(templateObject, templatePath) {
  if (templateObject && typeof templateObject === "object" && templateObject.file) {
    return fs.readFileSync(path.join(templatePath, templateObject.file), "utf-8");
  }
  return templateObject;
}

function mergeLangFile(langObject, templatePath) {
  for (const [lang, text] of Object.entries(langObject)) {
    if (text && typeof text === "object" && text.file) {
      langObject[lang] = fs.readFileSync(path.join(templatePath, text.file), "utf-8");
    }
  }
}

async function pushEmailTemplates({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "email-templates");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no email-templates config at ${dir}\n`);
    return;
  }

  const templates = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name));

  for (const templatePath of templates) {
    const templateName = path.parse(templatePath).base;
    if (name && name !== templateName) continue;

    const jsonPath = path.join(templatePath, `${templateName}.json`);
    if (!fs.existsSync(jsonPath)) {
      emit(`Warning: missing ${jsonPath}, skipping\n`);
      continue;
    }
    const template = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    if (template.message) mergeLangFile(template.message, templatePath);
    if (template.html) mergeLangFile(template.html, templatePath);
    if (template.styles) template.styles = mergeFileContent(template.styles, templatePath);

    const requestUrl = `${tenantUrl}/openidm/config/${template._id}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, template, token);
  }
}

module.exports = { pushEmailTemplates };
