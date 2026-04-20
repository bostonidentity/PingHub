/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-iga-workflows.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restPost, restPut } = require("../common/restClient.js");

function mergeScriptFile(step, stepPath) {
  if (step.type === "scriptTask" && step.scriptTask?.script?.file) {
    const filePath = path.join(stepPath, step.scriptTask.script.file);
    if (fs.existsSync(filePath)) {
      step.scriptTask.script = fs.readFileSync(filePath, "utf-8");
    }
  }
}

async function pushIgaWorkflows({ configDir, tenantUrl, token, name, draft, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const workflowDir = path.join(configDir, "iga", "workflows");
  if (!fs.existsSync(workflowDir)) {
    emit(`Warning: no iga workflows at ${workflowDir}\n`);
    return;
  }

  const workflowPaths = fs
    .readdirSync(workflowDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(workflowDir, d.name));

  let workflowFound = !name;

  for (const workflowPath of workflowPaths) {
    const workflowName = path.parse(workflowPath).base;
    const workflow = JSON.parse(fs.readFileSync(path.join(workflowPath, `${workflowName}.json`), "utf-8"));
    if (name && name !== workflow.name) continue;
    workflowFound = true;

    if (!workflow.mutable) {
      emit(`Skipping immutable workflow ${workflow.name}\n`);
      continue;
    }

    const stepsDir = path.join(workflowPath, "steps");
    const stepPaths = fs.existsSync(stepsDir)
      ? fs.readdirSync(stepsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(stepsDir, d.name))
      : [];

    const steps = [];
    for (const stepPath of stepPaths) {
      const stepName = path.parse(stepPath).base;
      const step = JSON.parse(fs.readFileSync(path.join(stepPath, `${stepName}.json`), "utf-8"));
      mergeScriptFile(step, stepPath);
      steps.push(step);
    }
    workflow.steps = steps;
    workflow._rev = Math.floor(Date.now() / 1000);

    if (draft) {
      const requestUrl = `${tenantUrl}/auto/orchestration/definition/${workflow.id}`;
      emit(`PUT ${requestUrl} (draft)\n`);
      await restPut(requestUrl, workflow, token);
    } else {
      const requestUrl = `${tenantUrl}/auto/orchestration/definition`;
      emit(`POST ${requestUrl} (publish)\n`);
      await restPost(`${requestUrl}?_action=publish`, workflow, token);
    }
  }

  if (name && !workflowFound) {
    throw new Error(`iga workflow "${name}" not found under ${workflowDir}`);
  }
}

module.exports = { pushIgaWorkflows };
