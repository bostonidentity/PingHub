/*
 * Subset of @forgerock/fr-config-manager/packages/fr-config-common/src/restClient.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Scope: exports only restGet — the one function pull/managed.js uses.
 * Retry count matches upstream default (2). No proxy support; add back if needed.
 */

const axios = require("axios");

const MAX_RETRIES = 2;

// Direct-control / DCC staging mode. When true, every outbound request
// also carries `X-Configuration-Type: mutable` so the AIC backend routes
// it through the open direct-configuration session (matches upstream
// restClient behavior under the `--direct-control` global flag). The
// caller (typically fr-config-dispatch) flips this on before a vendored
// push call and off again afterwards.
let directControlMode = false;
function setDirectControlMode(on) { directControlMode = !!on; }
function getDirectControlMode() { return directControlMode; }

async function httpRequest(config, token) {
  const headers = { ...(config.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (directControlMode) headers["X-Configuration-Type"] = "mutable";
  const merged = {
    ...config,
    headers,
    validateStatus: (s) => s >= 200 && s < 300,
  };

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios(merged);
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status == null || status < 500 || status > 599) break;
      if (attempt < MAX_RETRIES) {
        // eslint-disable-next-line no-console
        console.error(`Retry ${attempt + 1}/${MAX_RETRIES} for ${config.url}...`);
      }
    }
  }
  throw lastErr;
}

async function restGet(url, params, token) {
  return httpRequest({ method: "GET", url, params }, token);
}

async function restPut(url, data, token, apiVersion, ifMatch, ifNoneMatch) {
  const headers = { "Content-Type": "application/json" };
  if (apiVersion) headers["Accept-Api-Version"] = apiVersion;
  if (ifMatch) headers["If-Match"] = ifMatch;
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  return httpRequest({ method: "PUT", url, data, headers }, token);
}

/**
 * Upsert: PUT with If-Match "*" when the resource exists, else PUT with
 * If-None-Match "*". Upstream's restUpsert GETs first to detect existence;
 * preserve that behavior.
 */
async function restUpsert(url, data, token, apiVersion) {
  try {
    await restGet(url, null, token);
    return await restPut(url, data, token, apiVersion, "*", undefined);
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404) {
      return await restPut(url, data, token, apiVersion, undefined, "*");
    }
    throw e;
  }
}

async function restPost(url, dataOrParams, dataOrToken, tokenOrApiVersion, maybeApiVersion) {
  // Accept both (url, data, token, apiVersion) and
  // (url, params, data, token, apiVersion) shapes. Upstream uses both.
  let params, data, token, apiVersion;
  if (typeof dataOrToken === "string") {
    // 4-arg form: (url, data, token, apiVersion)
    data = dataOrParams;
    token = dataOrToken;
    apiVersion = tokenOrApiVersion;
  } else {
    // 5-arg form: (url, params, data, token, apiVersion)
    params = dataOrParams;
    data = dataOrToken;
    token = tokenOrApiVersion;
    apiVersion = maybeApiVersion;
  }
  const headers = { "Content-Type": "application/json" };
  if (apiVersion) headers["Accept-Api-Version"] = apiVersion;
  return httpRequest({ method: "POST", url, data, headers, ...(params ? { params } : {}) }, token);
}

async function restDelete(url, token, apiVersion) {
  const headers = {};
  if (apiVersion) headers["Accept-Api-Version"] = apiVersion;
  return httpRequest({ method: "DELETE", url, headers }, token);
}

module.exports = {
  restGet, restPut, restUpsert, restPost, restDelete,
  setDirectControlMode, getDirectControlMode,
};
