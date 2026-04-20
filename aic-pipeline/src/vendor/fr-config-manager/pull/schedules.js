/*
 * Adapted from @forgerock/fr-config-manager/packages/fr-config-pull/src/scripts/schedules.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 */

const fs = require("fs");
const path = require("path");
const { restGet } = require("../common/restClient.js");

const SCHEDULE_SUBDIR = "schedules";

async function pullSchedules({ exportDir, tenantUrl, token, name, log }) {
  if (!exportDir) throw new Error("exportDir is required");
  if (!tenantUrl) throw new Error("tenantUrl is required");
  if (!token) throw new Error("token is required");
  const emit = typeof log === "function" ? log : () => {};

  const idmEndpoint = `${tenantUrl}/openidm/config`;
  emit(`GET ${idmEndpoint} (schedules)\n`);
  const response = await restGet(idmEndpoint, { _queryFilter: '_id sw "schedule/"' }, token);

  const fileDir = path.join(exportDir, SCHEDULE_SUBDIR);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

  for (const schedule of response.data.result) {
    const scheduleName = schedule._id.split("/")[1];
    if (name && name !== scheduleName) continue;

    const scheduleDir = path.join(fileDir, scheduleName);
    if (!fs.existsSync(scheduleDir)) fs.mkdirSync(scheduleDir, { recursive: true });

    const scriptFilename = `${scheduleName}.js`;
    if (schedule.invokeService === "script" && schedule.invokeContext?.script?.source) {
      fs.writeFileSync(path.join(scheduleDir, scriptFilename), schedule.invokeContext.script.source);
      delete schedule.invokeContext.script.source;
      schedule.invokeContext.script.file = scriptFilename;
    } else if (schedule.invokeService === "taskscanner" && schedule.invokeContext?.task?.script?.source) {
      fs.writeFileSync(path.join(scheduleDir, scriptFilename), schedule.invokeContext.task.script.source);
      delete schedule.invokeContext.task.script.source;
      schedule.invokeContext.task.script.file = scriptFilename;
    }

    fs.writeFileSync(path.join(scheduleDir, `${scheduleName}.json`), JSON.stringify(schedule, null, 2));
    emit(`  ← ${scheduleName}\n`);
  }
}

module.exports = { pullSchedules };
