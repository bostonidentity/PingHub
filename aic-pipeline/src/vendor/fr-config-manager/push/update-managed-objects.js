/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-managed-objects.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 *
 * Adapter changes vs upstream:
 *   - Accepts configDir / tenantUrl / token / name as arguments instead of
 *     process.env + argv, so this can run in-process.
 *   - Throws on error instead of calling process.exit(1).
 *   - Optional `log` callback receives stdout-style progress strings.
 */

const fs = require("fs");
const path = require("path");
const { restPut, restGet } = require("../common/restClient.js");

const SCRIPT_HOOKS = ["onStore", "onRetrieve", "onValidate"];

async function mergeExistingObjects(newManagedObject, resourceUrl, token) {
  const result = await restGet(resourceUrl, null, token);
  const existingObjects = result.data.objects;

  const existingObjectIndex = existingObjects.findIndex(
    (el) => el.name === newManagedObject.name,
  );
  if (existingObjectIndex >= 0) existingObjects.splice(existingObjectIndex, 1);
  existingObjects.push(newManagedObject);
  return existingObjects;
}

function mergeScriptFile(value, managedObjectPath) {
  if (value.type && value.type === "text/javascript" && value.file) {
    const scriptFilePath = path.join(managedObjectPath, value.file);
    if (fs.existsSync(scriptFilePath)) {
      value.source = fs.readFileSync(scriptFilePath, { encoding: "utf-8" });
      delete value.file;
    }
  }
}

async function updateManagedObjects({ configDir, tenantUrl, token, name, log }) {
  const emit = typeof log === "function" ? log : () => {};
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");

  if (name) emit(`Updating managed object ${name}\n`);
  else emit("Updating managed objects\n");

  const customRelationshipSchema = [];
  const dir = path.join(configDir, "managed-objects");
  if (!fs.existsSync(dir)) {
    emit("Warning: no managed objects defined\n");
    return;
  }

  const managedObjectPaths = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name));

  let managedObjects = [];
  for (const managedObjectPath of managedObjectPaths) {
    const managedObjectName = path.parse(managedObjectPath).base;
    if (name && name !== managedObjectName) continue;

    const jsonPath = path.join(managedObjectPath, `${managedObjectName}.json`);
    if (!fs.existsSync(jsonPath)) {
      emit(`Skipping ${managedObjectName}: missing ${managedObjectName}.json\n`);
      continue;
    }
    const managedObject = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    Object.entries(managedObject).forEach(([, value]) => {
      mergeScriptFile(value, managedObjectPath);
    });

    if (managedObject.actions) {
      Object.entries(managedObject.actions).forEach(([, value]) => {
        mergeScriptFile(value, managedObjectPath);
      });
    }

    Object.entries(managedObject.schema.properties).forEach(([, value]) => {
      SCRIPT_HOOKS.forEach((hook) => {
        if (Object.prototype.hasOwnProperty.call(value, hook) && value[hook].file) {
          const scriptFilePath = path.join(managedObjectPath, value[hook].file);
          if (fs.existsSync(scriptFilePath)) {
            value[hook].source = fs.readFileSync(scriptFilePath, { encoding: "utf-8" });
            delete value[hook].file;
          }
        }
      });
    });

    const schemaDir = path.join(managedObjectPath, "schema");
    if (fs.existsSync(schemaDir)) {
      const schemaFiles = fs
        .readdirSync(schemaDir)
        .filter((n) => path.extname(n) === ".json");
      for (const schemaFile of schemaFiles) {
        const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, schemaFile), "utf-8"));
        customRelationshipSchema.push({ object: managedObject.name, schema });
      }
    }

    managedObjects.push(managedObject);
  }

  const requestUrl = `${tenantUrl}/openidm/config/managed`;

  if (name) {
    if (managedObjects.length === 0) {
      throw new Error(`managed object "${name}" not found under ${dir}`);
    }
    managedObjects = await mergeExistingObjects(managedObjects[0], requestUrl, token);
  }

  emit(`PUT ${requestUrl} (${managedObjects.length} object${managedObjects.length === 1 ? "" : "s"})\n`);
  await restPut(requestUrl, { objects: managedObjects }, token);

  // Upstream does this "to avoid 404" — keep it.
  await restGet(requestUrl, null, token);

  for (const r of customRelationshipSchema) {
    const schemaUrl = `${tenantUrl}/openidm/schema/managed/${r.object}/properties/${r.schema._id}`;
    emit(`PUT ${schemaUrl}\n`);
    await restPut(schemaUrl, r.schema, token, "resource=2.0", false, "*");
  }
}

module.exports = { updateManagedObjects };
