/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/igaWorkflows.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const EXPORT_SUBDIR = "iga/workflows";

// Workflow / step names come from user-authored content and can contain
// characters that are invalid in filesystem path segments on macOS/Linux/Windows
// (most notably "/"). Sanitize before using as a dir or filename; keep the
// original in the JSON body.
function safeSegment(s) {
  return String(s).replace(/[<>:"/\\|?*]/g, "_");
}

function breakoutSteps(workflow, workflowPath) {
  const stepsPath = path.join(workflowPath, "steps");
  for (const step of workflow.steps) {
    const uniqueId = `${step.displayName} - ${step.name}`;
    const safeUniqueId = safeSegment(uniqueId);
    const stepPath = path.join(stepsPath, safeUniqueId);
    if (!fs.existsSync(stepPath)) fs.mkdirSync(stepPath, { recursive: true });

    if (step.type === "scriptTask" && step.scriptTask?.script) {
      const scriptFilename = `${safeUniqueId}.js`;
      fs.writeFileSync(path.join(stepPath, scriptFilename), step.scriptTask.script);
      step.scriptTask.script = { file: scriptFilename };
    }

    fs.writeFileSync(path.join(stepPath, `${safeUniqueId}.json`), JSON.stringify(step, null, 2));
  }
  delete workflow.steps;
}

async function pullIgaWorkflows({ exportDir, tenantUrl, token, name, includeImmutable, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const endpoint = `${tenantUrl}/auto/orchestration/definition`;
  emit(`GET ${endpoint}\n`);
  const response = await restGet(endpoint, { _pageSize: 100 }, token);
  const workflows = response.data.result;

  const targetDir = path.join(exportDir, EXPORT_SUBDIR);
  let workflowFound = false;

  for (const workflow of workflows) {
    if (name && name !== workflow.name) continue;
    if (!workflow.mutable && !includeImmutable) continue;
    workflowFound = true;

    const safeName = safeSegment(workflow.name);
    const workflowPath = path.join(targetDir, safeName);
    if (!fs.existsSync(workflowPath)) fs.mkdirSync(workflowPath, { recursive: true });
    breakoutSteps(workflow, workflowPath);
    fs.writeFileSync(path.join(workflowPath, `${safeName}.json`), JSON.stringify(workflow, null, 2));
    emit(`  ← ${workflow.name}\n`);
  }

  if (name && !workflowFound) emit(`Workflow ${name} not found\n`);
}

module.exports = { pullIgaWorkflows };
