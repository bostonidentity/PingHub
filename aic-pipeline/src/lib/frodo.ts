/**
 * Frodo scope runner — handles am-agents, oidc-providers, and variables.
 *
 * Previously spawned the `frodo` CLI. Now dispatches the 3 scopes to the
 * vendored in-process pull/push functions. spawnFrodo keeps the same
 * `{ stream, abort }` return shape so callers in /api/pull, /api/push, etc.
 * don't need changes.
 */

import path from "path";
import fs from "fs";
import { getConfigDir, getEnvFileContent, classifyBenign } from "./fr-config";
import { parseEnvFile } from "./env-parser";
import { dispatchFrConfig } from "./fr-config-dispatch";
import { getAccessToken } from "./iga-api";

const ENVIRONMENTS_DIR = path.join(process.cwd(), "environments");

// ── Scope → frodo command mapping ─────────────────────────────────────────────

interface FrodoScopeConfig {
  pullArgs: string[];
  pushArgs: string[];
  /** Subdirectory under configDir where files are stored */
  subdir: string;
}

const FRODO_SCOPE_CONFIG: Record<string, FrodoScopeConfig> = {
  "am-agents": {
    pullArgs: ["agent", "export", "-A"],
    pushArgs: ["agent", "import", "-A"],
    subdir: "agents",
  },
  "oidc-providers": {
    pullArgs: ["idp", "export", "-A"],
    pushArgs: ["idp", "import", "-A"],
    subdir: "idp",
  },
  "variables": {
    pullArgs: ["esv", "variable", "export", "-A"],
    pushArgs: ["esv", "variable", "import", "-A"],
    subdir: "esvs/variables",
  },
};

export const FRODO_SCOPES = Object.keys(FRODO_SCOPE_CONFIG);

// ── Spawn helper ───────────────────────────────────────────────────────────────

export function spawnFrodo(options: {
  command: "fr-config-pull" | "fr-config-push";
  scopes: string[];
  environment: string;
}): { stream: ReadableStream<string>; abort: () => void } {
  const { command, scopes, environment } = options;

  const configDir = getConfigDir(environment);
  const envContent = getEnvFileContent(environment);
  const envVars = parseEnvFile(envContent);
  const envDir = path.join(ENVIRONMENTS_DIR, environment);

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 3000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let aborted = false;

  const stream = new ReadableStream<string>({
    async start(controller) {
      const encode = (data: string, type: "stdout" | "stderr") => {
        controller.enqueue(JSON.stringify({ type, data, ts: Date.now() }) + "\n");
      };

      let anyFailed = false;

      // Acquire one bearer token at the start of the run and reuse it for
      // every scope. Tokens are valid for ~15 min. If the tenant returns
      // 401/403, the inner retry loop passes force=true and we re-acquire.
      let sharedToken: string | undefined;
      const refreshToken = async (force = false): Promise<string | undefined> => {
        if (!force && sharedToken) return sharedToken;
        try {
          sharedToken = await getAccessToken(
            envVars as Record<string, string>,
            // Informational token progress — real errors go via the catch
            // branch below. Keep these on stdout so they don't land in the
            // promote UI's "Error logs" panel.
            (msg) => encode(`[token] ${msg}\n`, "stdout"),
          );
        } catch (err) {
          encode(`token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, "stderr");
          sharedToken = undefined;
        }
        return sharedToken;
      };
      await refreshToken();

      for (const scope of scopes) {
        if (aborted) break;
        const cfg = FRODO_SCOPE_CONFIG[scope];
        if (!cfg) continue;

        if (!configDir) {
          encode(`Config dir not found for environment "${environment}"`, "stderr");
          anyFailed = true;
          continue;
        }

        // Ensure target directory exists for pull so vendored writes have a
        // home — the vendored functions also mkdir, this just mirrors the
        // old behavior.
        const targetDir = path.join(configDir, cfg.subdir);
        if (command === "fr-config-pull" && !fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        controller.enqueue(
          JSON.stringify({ type: "scope-start", scope, ts: Date.now() }) + "\n"
        );

        let exitCode: number | null = null;
        let lastStderr = "";
        let lastStdout = "";

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (aborted) break;
          if (attempt > 0) {
            encode(`Retry ${attempt}/${MAX_RETRIES} for ${scope}...`, "stderr");
            await sleep(RETRY_DELAY_MS);
          }

          // Only burn a fresh token when the previous attempt actually failed
          // with 401/403. Other failures (400, 5xx, network) retry with same token.
          const needsAuthRefresh = attempt > 0 &&
            /status code (401|403)|\bHTTP\s*(401|403)\b/i.test(lastStderr);

          lastStderr = "";
          lastStdout = "";
          const captureEmit = (data: string, type: "stdout" | "stderr") => {
            if (type === "stdout") lastStdout += data;
            else lastStderr += data;
            encode(data, type);
          };

          const tokenForScope = await refreshToken(needsAuthRefresh);

          const dispatched = await dispatchFrConfig({
            command,
            scope,
            envVars: envVars as Record<string, string | undefined>,
            envDir,
            extraArgs: [],
            extraEnv: {},
            emit: captureEmit,
            token: tokenForScope,
          });

          if (dispatched.handled) {
            exitCode = dispatched.code ?? 0;
          } else {
            // No vendored handler for this scope — surface it clearly instead
            // of silently leaving it out.
            encode(`frodo scope "${scope}" is not vendored (dispatcher returned unhandled)\n`, "stderr");
            exitCode = 1;
          }

          if (exitCode === 0) break;
        }

        let benignReason: string | null = null;
        if (exitCode !== 0) {
          benignReason = classifyBenign(lastStderr) ?? classifyBenign(lastStdout);
          if (benignReason) {
            exitCode = 0;
          } else {
            anyFailed = true;
          }
        }

        const endPayload: Record<string, unknown> = {
          type: "scope-end", scope, code: exitCode, ts: Date.now(),
        };
        if (benignReason) endPayload.warning = benignReason;
        controller.enqueue(JSON.stringify(endPayload) + "\n");
      }

      controller.enqueue(
        JSON.stringify({ type: "exit", code: aborted ? 130 : (anyFailed ? 1 : 0), ts: Date.now() }) + "\n"
      );
      controller.close();
    },
    cancel() {
      aborted = true;
    },
  });

  return {
    stream,
    abort: () => {
      aborted = true;
    },
  };
}

// ── Directory helpers for audit ────────────────────────────────────────────────

export function getFrodoScopeDir(scope: string): string | null {
  return FRODO_SCOPE_CONFIG[scope]?.subdir ?? null;
}
