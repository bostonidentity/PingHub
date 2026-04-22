/*
 * Subset of @forgerock/fr-config-manager/packages/fr-config-common/src/restClient.js
 * Upstream: https://github.com/ForgeRock/fr-config-manager (v1.5.12, Apache-2.0)
 * Scope: exports only restGet — the one function pull/managed.js uses.
 * Retry count matches upstream default (2). No proxy support; add back if needed.
 */

const axios = require("axios");

const MAX_RETRIES = 2;
// Per-request timeout. Upstream sets none (axios default 0 = wait forever),
// which means a hung AIC endpoint silently hangs the entire push — the
// streaming HTTP response from our API route stays open with no further
// bytes, the browser eventually drops the fetch as a network error, and
// the operator has no idea WHICH request stalled. A generous-but-finite
// budget surfaces the underlying ECONNABORTED with the URL via the
// error-decoration code below, which is what we actually need to triage.
const REQUEST_TIMEOUT_MS = 60_000;

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
    timeout: REQUEST_TIMEOUT_MS,
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
      // Retry on:
      //   - 5xx HTTP responses (transient server-side)
      //   - network-level errors (no HTTP response received: ECONNRESET,
      //     ETIMEDOUT, ENOTFOUND, EAI_AGAIN, etc.)
      // Bail immediately on 4xx and any other non-retryable shape.
      const isNetworkError = status == null;
      const isRetryable5xx = status != null && status >= 500 && status <= 599;
      if (!isNetworkError && !isRetryable5xx) break;
      if (attempt < MAX_RETRIES) {
        const reason = isNetworkError
          ? `network error${err?.code ? ` (${err.code})` : ""}`
          : `HTTP ${status}`;
        // eslint-disable-next-line no-console
        console.error(`Retry ${attempt + 1}/${MAX_RETRIES} for ${config.url} — ${reason}...`);
      }
    }
  }
  // Decorate the thrown error so the caller's log gets actionable detail
  // instead of axios's terse default. Two cases:
  //   - HTTP error: append the tenant's response body (truncated at 500
  //     chars). Body shape is usually {code,reason,message,…}.
  //   - Network error: append err.code (and err.cause if present) so the
  //     reader can tell ECONNRESET from ETIMEDOUT from DNS failure etc.
  if (lastErr?.response) {
    const body = lastErr.response.data;
    let snippet = "";
    if (body) {
      try { snippet = typeof body === "string" ? body : JSON.stringify(body); }
      catch { snippet = String(body); }
    }
    if (snippet) {
      if (snippet.length > 500) snippet = snippet.slice(0, 500) + "…(truncated)";
      const baseMsg = lastErr.message || "Request failed";
      lastErr.message = `${baseMsg}: ${snippet}`;
    }
  } else if (lastErr) {
    const parts = [];
    if (lastErr.code) parts.push(lastErr.code);
    const causeCode = lastErr.cause && lastErr.cause.code;
    const causeMsg = lastErr.cause && lastErr.cause.message;
    if (causeCode && causeCode !== lastErr.code) parts.push(causeCode);
    if (causeMsg && !parts.includes(causeMsg)) parts.push(causeMsg);
    if (parts.length > 0) {
      const baseMsg = lastErr.message || "Request failed";
      lastErr.message = `${baseMsg} [${parts.join(" / ")}] — ${(config.method || "GET").toUpperCase()} ${config.url}`;
    } else {
      const baseMsg = lastErr.message || "Request failed";
      lastErr.message = `${baseMsg} — ${(config.method || "GET").toUpperCase()} ${config.url}`;
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
