/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/helpers/config-process.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter: process.exit(1) replaced with throw. envVars argument
 * overridable (defaults to process.env).
 */

const BASE64_PRE_ENCODED_PREFIX = "BASE64:";

function unescapePlaceholders(content) {
  return typeof content === "string" ? content.replace(/\\\$\{/g, "${") : content;
}

function replaceEnvSpecificValues(content, base64Encode = false, envVars = process.env) {
  const placeholders = content.match(/\\*?\${.*?}/g);
  if (!placeholders) return content;

  let newContent = content;
  for (const placeholder of placeholders) {
    if (placeholder.startsWith("\\\\")) continue;
    let placeholderName = placeholder.replace(/\${(.*)}/, "$1");
    let encode = base64Encode;

    if (placeholderName.startsWith(BASE64_PRE_ENCODED_PREFIX)) {
      encode = false;
      placeholderName = placeholderName.substring(BASE64_PRE_ENCODED_PREFIX.length);
    }

    const value = envVars[placeholderName];
    if (value === undefined || value === null || value === "") {
      throw new Error(`no environment variable for ${placeholderName}`);
    }
    const substituted = encode ? Buffer.from(value).toString("base64") : value;
    newContent = newContent.replaceAll(placeholder, substituted);
  }
  return unescapePlaceholders(newContent);
}

function removeProperty(obj, propertyName) {
  for (const prop in obj) {
    if (prop === propertyName) {
      delete obj[prop];
    } else if (obj[prop] && typeof obj[prop] === "object") {
      removeProperty(obj[prop], propertyName);
    }
  }
}

function clearOperationalAttributes(obj) {
  delete obj._id;
  delete obj._rev;
  delete obj._pushApiVersion;
  delete obj.createdBy;
  delete obj.creationDate;
  delete obj.lastModifiedBy;
  delete obj.lastModifiedDate;
}

module.exports = { replaceEnvSpecificValues, removeProperty, clearOperationalAttributes };
