/**
 * IGA REST API runner — handles iga-applications, iga-entitlements, iga-notifications.
 * Authenticates using the service account JWK and calls /iga/governance/* endpoints.
 */

import path from "path";
import fs from "fs";
import { SignJWT, importJWK } from "jose";
import { randomUUID } from "crypto";
import { getConfigDir, getEnvFileContent } from "./fr-config";
import { parseEnvFile } from "./env-parser";

// ── Scope → API config ────────────────────────────────────────────────────────

interface IgaScopeConfig {
  /** IGA REST API endpoint path */
  endpoint: string;
  /** Subdirectory under configDir where files are stored */
  subdir: string;
  /** Field in each result item to use as the file ID */
  idField: string;
  /** Whether to fetch full item detail by ID (some endpoints only list summary) */
  fetchDetail: boolean;
  /** Whether push (import) is supported */
  pushSupported: boolean;
  /** Pagination style: "cursor" = searchAfterKey, "offset" = _pagedResultsOffset + _queryFilter */
  pagination: "cursor" | "offset";
}

const IGA_SCOPE_CONFIG: Record<string, IgaScopeConfig> = {
  "iga-applications": {
    endpoint: "/iga/governance/application",
    subdir: "iga/applications",
    idField: "id",
    fetchDetail: true,
    pushSupported: true,
    pagination: "cursor",
  },
  "iga-entitlements": {
    endpoint: "/iga/governance/entitlement",
    subdir: "iga/entitlements",
    idField: "id",
    fetchDetail: false,
    pushSupported: false,
    pagination: "cursor",
  },
  "iga-forms": {
    endpoint: "/iga/governance/requestForms",
    subdir: "iga/forms",
    idField: "id",
    fetchDetail: true,
    pushSupported: true,
    pagination: "offset",
  },
  "iga-assignments": {
    endpoint: "/iga/governance/requestFormAssignments",
    subdir: "iga/assignments",
    idField: "formId",           // no unique ID; use formId+objectId composite for filename
    fetchDetail: false,
    pushSupported: true,
    pagination: "offset",
  },
  "iga-notifications": {
    endpoint: "/iga/governance/notification",
    subdir: "iga/notifications",
    idField: "_id",
    fetchDetail: false,
    pushSupported: false,
    pagination: "cursor",
  },
};

export const IGA_API_SCOPES = Object.keys(IGA_SCOPE_CONFIG);

// ── Token acquisition ─────────────────────────────────────────────────────────

/** Mask a bearer token for safe logging: "eyJh…3f2A" style. */
function maskToken(t: string): string {
  if (!t) return "<empty>";
  if (t.length <= 12) return "****";
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
}

export async function getAccessToken(
  envVars: Record<string, string>,
  log?: (msg: string) => void,
): Promise<string> {
  const tenantUrl = envVars.TENANT_BASE_URL ?? "";
  const saId = envVars.SERVICE_ACCOUNT_ID ?? "";
  const saKey = envVars.SERVICE_ACCOUNT_KEY ?? "";
  const clientId = envVars.SERVICE_ACCOUNT_CLIENT_ID ?? "service-account";
  const scope = (envVars.SERVICE_ACCOUNT_SCOPE ?? "fr:am:* fr:idm:* fr:iga:*")
    .split(" ").filter(Boolean).join(" ");

  const tokenEndpoint = `${tenantUrl}/am/oauth2/access_token`;
  log?.(`→ POST ${tokenEndpoint} (sa=${saId || "<missing>"}, scope=${scope})`);

  const jwk = JSON.parse(saKey);
  const key = await importJWK(jwk, "RS256");

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(saId)
    .setSubject(saId)
    .setAudience(tokenEndpoint)
    .setJti(randomUUID())
    .setExpirationTime("3m")
    .sign(key);

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: clientId,
    scope,
    assertion: jwt,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    body: params,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const data = await res.json() as {
    access_token?: string;
    error?: string;
    error_description?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!data.access_token) {
    const msg = data.error_description ?? data.error ?? JSON.stringify(data);
    log?.(`✗ token error (HTTP ${res.status}): ${msg}`);
    throw new Error(`Token error: ${msg}`);
  }
  const granted = data.scope ?? "(not reported)";
  const ttl = data.expires_in != null ? `${data.expires_in}s` : "(unknown)";
  log?.(`✓ token acquired ${maskToken(data.access_token)} · expires_in=${ttl} · granted=${granted}`);
  return data.access_token;
}

// ── Pagination helpers ────────────────────────────────────────────────────────

type AuthedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Cursor-based pagination using searchAfterKey (application, entitlement, notification). */
async function* paginateCursor(
  tenantUrl: string,
  endpoint: string,
  authedFetch: AuthedFetch,
  pageSize = 100
): AsyncGenerator<Record<string, unknown>> {
  let searchAfterKey: unknown[] | null = null;

  while (true) {
    const url = new URL(`${tenantUrl}${endpoint}`);
    url.searchParams.set("_pageSize", String(pageSize));
    if (searchAfterKey) {
      url.searchParams.set("_searchAfterKey", JSON.stringify(searchAfterKey));
    }

    const res = await authedFetch(url.toString());
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`IGA API ${res.status}: ${endpoint}`);

    const data = await res.json() as {
      result?: Record<string, unknown>[];
      searchAfterKey?: unknown[];
    };

    const items = data.result ?? [];
    for (const item of items) yield item;
    if (!data.searchAfterKey || items.length === 0) break;
    searchAfterKey = data.searchAfterKey;
  }
}

/** Offset-based pagination using _pagedResultsOffset + _queryFilter (requestForms). */
async function* paginateOffset(
  tenantUrl: string,
  endpoint: string,
  authedFetch: AuthedFetch,
  pageSize = 100
): AsyncGenerator<Record<string, unknown>> {
  let offset = 0;

  while (true) {
    const url = new URL(`${tenantUrl}${endpoint}`);
    url.searchParams.set("_pageSize", String(pageSize));
    url.searchParams.set("_pagedResultsOffset", String(offset));
    url.searchParams.set("_queryFilter", "true");

    const res = await authedFetch(url.toString());
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`IGA API ${res.status}: ${endpoint}`);

    const data = await res.json() as {
      result?: Record<string, unknown>[];
      resultCount?: number;
      totalCount?: number;
    };

    const items = data.result ?? [];
    for (const item of items) yield item;
    if (items.length < pageSize) break;
    offset += items.length;
  }
}

function paginateIga(
  tenantUrl: string,
  endpoint: string,
  authedFetch: AuthedFetch,
  cfg: IgaScopeConfig,
  pageSize = 100
): AsyncGenerator<Record<string, unknown>> {
  return cfg.pagination === "offset"
    ? paginateOffset(tenantUrl, endpoint, authedFetch, pageSize)
    : paginateCursor(tenantUrl, endpoint, authedFetch, pageSize);
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runIgaApi(options: {
  command: "fr-config-pull" | "fr-config-push";
  scopes: string[];
  environment: string;
}): { stream: ReadableStream<string>; abort: () => void } {
  const { command, scopes, environment } = options;
  const isPull = command === "fr-config-pull";

  let aborted = false;

  const stream = new ReadableStream<string>({
    async start(controller) {
      const emit = (type: string, data: Record<string, unknown>) => {
        controller.enqueue(JSON.stringify({ type, ...data, ts: Date.now() }) + "\n");
      };
      const log = (text: string, isErr = false) => {
        controller.enqueue(
          JSON.stringify({ type: isErr ? "stderr" : "stdout", data: text + "\n", ts: Date.now() }) + "\n"
        );
      };

      const configDir = getConfigDir(environment);
      if (!configDir) {
        log(`Config dir not found for environment "${environment}"`, true);
        emit("exit", { code: 1 });
        controller.close();
        return;
      }

      const envVars = parseEnvFile(getEnvFileContent(environment));
      const tenantUrl = envVars.TENANT_BASE_URL ?? "";

      const MAX_RETRIES = 2;
      const RETRY_DELAY_MS = 3000;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // Acquire access token once up-front; refresh only on 401/403 inside
      // authedFetch. Retries on other (transient) errors reuse the same token.
      let token: string;
      try {
        log("Acquiring access token…");
        token = await getAccessToken(envVars);
        log("Token acquired. Will refresh only on 401/403.");
      } catch (err) {
        log(`Failed to acquire access token: ${err instanceof Error ? err.message : String(err)}`, true);
        emit("exit", { code: 1 });
        controller.close();
        return;
      }

      const authedFetch: AuthedFetch = async (url, init = {}) => {
        const call = () =>
          fetch(url, {
            ...init,
            headers: {
              ...((init.headers as Record<string, string> | undefined) ?? {}),
              Authorization: `Bearer ${token}`,
            },
          });
        let res = await call();
        if (res.status === 401 || res.status === 403) {
          log(`Auth ${res.status} on ${url} — refreshing access token…`);
          try {
            token = await getAccessToken(envVars);
            log("Token refreshed.");
          } catch (err) {
            log(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`, true);
            return res;
          }
          res = await call();
        }
        return res;
      };

      let anyFailed = false;

      for (const scope of scopes) {
        if (aborted) break;
        const cfg = IGA_SCOPE_CONFIG[scope];
        if (!cfg) continue;

        emit("scope-start", { scope });

        let scopeOk = false;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (aborted) break;
          if (attempt > 0) {
            log(`[${scope}] Retry ${attempt}/${MAX_RETRIES}...`);
            await sleep(RETRY_DELAY_MS);
          }

          try {
          if (isPull) {
            // ── Pull (export) ────────────────────────────────────────────────
            const scopeDir = path.join(configDir, cfg.subdir);
            if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });

            log(`[${scope}] Fetching from ${tenantUrl}${cfg.endpoint}…`);
            let count = 0;

            for await (const item of paginateIga(tenantUrl, cfg.endpoint, authedFetch, cfg)) {
              if (aborted) break;

              // Build a safe filename — for assignments use formId+objectId composite
              let fileId: string;
              if (scope === "iga-assignments") {
                const formId  = String(item["formId"]  ?? "unknown");
                const objId   = String(item["objectId"] ?? "");
                // objectId = "workflow/name/node/nodeId" → sanitize slashes
                const safePart = objId.replace(/\//g, "__");
                fileId = `${formId}__${safePart}`;
              } else {
                const rawId = item[cfg.idField];
                fileId = typeof rawId === "string" ? rawId : JSON.stringify(rawId);
              }
              if (!fileId) continue;

              let fullItem = item;

              // Fetch full detail if the list only returns a summary
              if (cfg.fetchDetail) {
                const detailRes = await authedFetch(
                  `${tenantUrl}${cfg.endpoint}/${encodeURIComponent(fileId)}`
                );
                if (detailRes.ok) {
                  fullItem = await detailRes.json() as Record<string, unknown>;
                }
              }

              // Sanitize filename (remove chars unsafe on most filesystems)
              const safeFileName = fileId.replace(/[<>:"/\\|?*]/g, "_");
              fs.writeFileSync(path.join(scopeDir, `${safeFileName}.json`), JSON.stringify(fullItem, null, 2));
              count++;
              if (count % 10 === 0) log(`[${scope}] Saved ${count} items…`);
            }

            log(`[${scope}] Done. Saved ${count} item(s) to ${cfg.subdir}/`);

          } else {
            // ── Push (import) ────────────────────────────────────────────────
            if (!cfg.pushSupported) {
              log(`[${scope}] Push not supported for this scope (read-only).`, true);
              emit("scope-end", { scope, code: 1 });
              anyFailed = true;
              continue;
            }

            const scopeDir = path.join(configDir, cfg.subdir);
            if (!fs.existsSync(scopeDir)) {
              log(`[${scope}] No local files found at ${cfg.subdir}/`, true);
              emit("scope-end", { scope, code: 1 });
              anyFailed = true;
              continue;
            }

            const files = fs.readdirSync(scopeDir).filter((f) => f.endsWith(".json"));
            log(`[${scope}] Pushing ${files.length} item(s)…`);
            let pushed = 0;

            for (const file of files) {
              if (aborted) break;
              try {
                const content = JSON.parse(fs.readFileSync(path.join(scopeDir, file), "utf-8")) as Record<string, unknown>;
                const rawId = content[cfg.idField];
                const id = typeof rawId === "string" ? rawId : path.basename(file, ".json");

                // Try PUT (update); fall back to POST (create)
                const putRes = await authedFetch(
                  `${tenantUrl}${cfg.endpoint}/${encodeURIComponent(id)}`,
                  {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(content),
                  }
                );

                if (putRes.ok) {
                  log(`[${scope}] Updated: ${id}`);
                } else {
                  const postRes = await authedFetch(
                    `${tenantUrl}${cfg.endpoint}`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(content),
                    }
                  );
                  if (postRes.ok) {
                    log(`[${scope}] Created: ${id}`);
                  } else {
                    const errBody = await postRes.text();
                    log(`[${scope}] Failed to push ${id}: ${postRes.status} ${errBody.slice(0, 100)}`, true);
                  }
                }
                pushed++;
              } catch (err) {
                log(`[${scope}] Error pushing ${file}: ${err instanceof Error ? err.message : String(err)}`, true);
              }
            }

            log(`[${scope}] Done. Pushed ${pushed}/${files.length} item(s).`);
          }

          scopeOk = true;
          break; // success — no more retries

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[${scope}] Error: ${msg}`, true);
          // If auth is still failing after authedFetch's inline refresh, don't
          // burn outer retries — refreshing again won't help.
          const isAuthFail = /IGA API 40[13]:/.test(msg);
          if (isAuthFail || attempt === MAX_RETRIES) {
            emit("scope-end", { scope, code: 1 });
            anyFailed = true;
            break;
          }
        }
        } // end retry loop

        if (scopeOk) {
          emit("scope-end", { scope, code: 0 });
        }
      }

      emit("exit", { code: aborted ? 130 : (anyFailed ? 1 : 0) });
      controller.close();
    },
  });

  return {
    stream,
    abort: () => { aborted = true; },
  };
}

// ── Directory helpers for audit ────────────────────────────────────────────────

export function getIgaScopeDir(scope: string): string | null {
  return IGA_SCOPE_CONFIG[scope]?.subdir ?? null;
}

export function isIgaPushSupported(scope: string): boolean {
  return IGA_SCOPE_CONFIG[scope]?.pushSupported ?? false;
}
