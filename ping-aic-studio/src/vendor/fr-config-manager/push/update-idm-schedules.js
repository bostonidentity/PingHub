/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-push/src/scripts/update-idm-schedules.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 *
 * Adapter changes:
 *   - LOCAL PATCH: awaits each restPut. Upstream calls `restPut(...)` without
 *     `await` inside the for loop, so failures are swallowed.
 *   - Dropped fileFilter helper.
 */

const fs = require("fs");
const path = require("path");
const { restPut } = require("../common/restClient.js");

async function pushSchedules({ configDir, tenantUrl, token, name, log }) {
  if (!configDir) throw new Error("configDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const dir = path.join(configDir, "schedules");
  if (!fs.existsSync(dir)) {
    emit(`Warning: no schedules config at ${dir}\n`);
    return;
  }

  const schedulePaths = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name));

  for (const schedulePath of schedulePaths) {
    const dirName = path.parse(schedulePath).base;
    const schedule = JSON.parse(fs.readFileSync(path.join(schedulePath, `${dirName}.json`), "utf-8"));
    const scheduleName = schedule._id.split("/")[1];
    if (name && name !== scheduleName) continue;

    if (schedule.invokeService === "script" && schedule.invokeContext?.script?.file) {
      schedule.invokeContext.script.source = fs.readFileSync(path.join(schedulePath, schedule.invokeContext.script.file), "utf-8");
      delete schedule.invokeContext.script.file;
    } else if (schedule.invokeService === "taskscanner" && schedule.invokeContext?.task?.script?.file) {
      schedule.invokeContext.task.script.source = fs.readFileSync(path.join(schedulePath, schedule.invokeContext.task.script.file), "utf-8");
      delete schedule.invokeContext.task.script.file;
    }

    const requestUrl = `${tenantUrl}/openidm/config/${schedule._id}`;
    emit(`PUT ${requestUrl}\n`);
    await restPut(requestUrl, schedule, token);
  }
}

module.exports = { pushSchedules };
