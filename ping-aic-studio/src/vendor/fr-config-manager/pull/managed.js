/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/managed.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Local patches: see src/vendor/fr-config-manager/UPSTREAM.md
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

// Inlined from utils.js — the only helper this file needs.
function saveJsonToFile(data, filename) {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
}

const EXPORT_SUBDIR = "managed-objects";
const SCRIPT_HOOKS = ["onStore", "onRetrieve", "onValidate"];

let repoMapping = null;

async function getRepoMapping(tenantUrl, token) {
  if (repoMapping) {
    return repoMapping;
  }

  const configUrl = `${tenantUrl}/openidm/config/repo.ds`;
  const response = await restGet(configUrl, null, token);
  repoMapping = response.data;
  return repoMapping;
}

async function getCustomRelationships(managedObject, tenantUrl, token) {
  const mapping = await getRepoMapping(tenantUrl, token);
  let customRelationships = [];
  const objectMapping =
    mapping.resourceMapping.genericMapping[`managed/${managedObject.name}`];

  if (!objectMapping) {
    return customRelationships;
  }

  for (const [name, property] of Object.entries(
    managedObject.schema.properties
  )) {
    const mappingProperty = objectMapping.properties[name];
    if (
      mappingProperty &&
      mappingProperty.type === "reference" &&
      mappingProperty.ldapAttribute.startsWith("fr-idm-reference-")
    ) {
      customRelationships.push(name);
    }
  }
  return customRelationships;
}

// Split managed.json into separate objects, each with separate scripts

async function processManagedObjects(
  managedObjects,
  targetDir,
  name,
  pullCustomRelationships,
  tenantUrl,
  token,
  emit
) {
  emit = typeof emit === "function" ? emit : () => {};
  try {
    const matching = name ? managedObjects.filter((o) => o.name === name) : managedObjects;
    emit(`Writing ${matching.length} managed-object${matching.length === 1 ? "" : "s"}\n`);
    for (const managedObject of managedObjects) {
      if (name && name !== managedObject.name) {
        // LOCAL PATCH: upstream uses `return` here, which aborts the loop on
        // the first non-matching object. IDM's response order isn't stable, so
        // --name silently wrote nothing whenever the target wasn't first.
        continue;
      }
      emit(`  ← ${managedObject.name}\n`);

      const objectPath = path.join(targetDir, managedObject.name);

      if (!fs.existsSync(objectPath)) {
        fs.mkdirSync(objectPath, { recursive: true });
      }

      Object.entries(managedObject).forEach(([key, value]) => {
        if (value.type && value.type === "text/javascript" && value.source) {
          const scriptFilename = `${managedObject.name}.${key}.js`;
          value.file = scriptFilename;
          fs.writeFileSync(path.join(objectPath, scriptFilename), value.source);
          delete value.source;
        }
      });

      if (managedObject.actions) {
        Object.entries(managedObject.actions).forEach(([key, value]) => {
          if (value.type && value.type === "text/javascript" && value.source) {
            const scriptFilename = `${managedObject.name}.actions.${key}.js`;
            value.file = scriptFilename;
            fs.writeFileSync(
              path.join(objectPath, scriptFilename),
              value.source
            );
            delete value.source;
          }
        });
      }

      for (const [key, value] of Object.entries(
        managedObject.schema.properties
      )) {
        SCRIPT_HOOKS.forEach((hook) => {
          if (
            value.hasOwnProperty(hook) &&
            value[hook].type === "text/javascript" &&
            value[hook].source
          ) {
            const scriptFilename = `${managedObject.name}.${key}.${hook}.js`;
            value[hook].file = scriptFilename;
            fs.writeFileSync(
              path.join(objectPath, scriptFilename),
              value[hook].source
            );
            delete value[hook].source;
          }
        });
      }

      if (pullCustomRelationships) {
        const customRelationships = await getCustomRelationships(
          managedObject,
          tenantUrl,
          token
        );

        for (const customRelationship of customRelationships) {
          const schemaPath = path.join(objectPath, "schema");
          if (!fs.existsSync(schemaPath)) {
            fs.mkdirSync(schemaPath, { recursive: true });
          }
          const schemaUrl = `${tenantUrl}/openidm/schema/managed/${managedObject.name}/properties/${customRelationship}`;
          const schemaResponse = await restGet(schemaUrl, null, token);
          saveJsonToFile(
            schemaResponse.data,
            path.join(
              schemaPath,
              `${managedObject.name}.schema.${customRelationship}.json`
            )
          );
        }
      }

      const fileName = path.join(objectPath, `${managedObject.name}.json`);
      saveJsonToFile(managedObject, fileName);
    }
  } catch (err) {
    console.error(err);
  }
}

async function exportManagedObjects(
  exportDir,
  tenantUrl,
  name,
  pullCustomRelationships,
  token,
  log
) {
  const emit = typeof log === "function" ? log : () => {};
  const idmEndpoint = `${tenantUrl}/openidm/config/managed`;
  emit(`GET ${idmEndpoint}\n`);
  const response = await restGet(idmEndpoint, null, token);

  const managedObjects = response.data.objects;

  const fileDir = path.join(exportDir, EXPORT_SUBDIR);
  await processManagedObjects(
    managedObjects,
    fileDir,
    name,
    pullCustomRelationships,
    tenantUrl,
    token,
    emit,
  );
}

module.exports.exportManagedObjects = exportManagedObjects;
