import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { parseEnvFile } from "./env-parser";
import { dispatchFrConfig } from "./fr-config-dispatch";
import { getAccessToken } from "./iga-api";
export type { FrCommand, ConfigScope, Environment, RunOptions, ScopeSelection } from "./fr-config-types";
export { CONFIG_SCOPES, FILENAME_FILTER_SCOPES, NAME_FLAG_SCOPES } from "./fr-config-types";
import type { Environment, RunOptions, ScopeSelection } from "./fr-config-types";
import { FILENAME_FILTER_SCOPES, NAME_FLAG_SCOPES } from "./fr-config-types";

const ENVIRONMENTS_DIR = path.join(process.cwd(), "environments");

// Benign non-zero exit patterns — "nothing to pull" rather than real failure.
// Shared across fr-config, frodo, and iga-api runners.
const BENIGN_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /Cannot convert undefined or null to object/i, reason: "no objects found" },
  { re: /Resource '[^']+' not found/i, reason: "resource not found" },
  { re: /Status:\s*404/i, reason: "resource not found (404)" },
  { re: /\bNot Found\b/i, reason: "resource not found" },
  { re: /no config metadata available/i, reason: "no config metadata" },
  { re: /no\s+\w+_CONFIG\s+defined\s*-\s*skipping/i, reason: "not configured — skipped" },
  { re: /Warning[^\n]*skipping/i, reason: "skipped" },
];

export function classifyBenign(buf: string): string | null {
  for (const { re, reason } of BENIGN_PATTERNS) {
    if (re.test(buf)) return reason;
  }
  return null;
}

export function getEnvironments(): Environment[] {
  const envPath = path.join(ENVIRONMENTS_DIR, "environments.json");
  if (!fs.existsSync(envPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(envPath, "utf-8"));
}

export function saveEnvironments(envs: Environment[]): void {
  if (!fs.existsSync(ENVIRONMENTS_DIR)) {
    fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
  }
  fs.writeFileSync(
    path.join(ENVIRONMENTS_DIR, "environments.json"),
    JSON.stringify(envs, null, 2)
  );
}

export function getEnvFilePath(environmentName: string): string {
  return path.join(ENVIRONMENTS_DIR, environmentName, ".env");
}

export function getEnvFileContent(environmentName: string): string {
  const filePath = getEnvFilePath(environmentName);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}

export function saveEnvFile(environmentName: string, content: string): void {
  const dir = path.join(ENVIRONMENTS_DIR, environmentName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getEnvFilePath(environmentName), content);
}

export function deleteEnvFolder(environmentName: string): void {
  const dir = path.join(ENVIRONMENTS_DIR, environmentName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function getConfigDir(environmentName: string): string | null {
  const filePath = getEnvFilePath(environmentName);
  if (!fs.existsSync(filePath)) return null;
  const vars = parseEnvFile(fs.readFileSync(filePath, "utf-8"));
  const configDirRaw = vars.CONFIG_DIR ?? "./config";
  const envDir = path.join(ENVIRONMENTS_DIR, environmentName);
  return path.resolve(envDir, configDirRaw);
}

// ── Log API credentials ──────────────────────────────────────────────────────

export interface LogApiCredentials {
  apiKey: string;
  apiSecret: string;
}

function logApiPath(environmentName: string): string {
  return path.join(ENVIRONMENTS_DIR, environmentName, "log-api.json");
}

export function getLogApiCredentials(environmentName: string): LogApiCredentials | null {
  const p = logApiPath(environmentName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function saveLogApiCredentials(environmentName: string, creds: LogApiCredentials): void {
  const dir = path.join(ENVIRONMENTS_DIR, environmentName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logApiPath(environmentName), JSON.stringify(creds, null, 2));
}

/** Load an env file and merge its values into process.env for a child process. */
function buildEnv(environmentName: string, overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const filePath = getEnvFilePath(environmentName);
  const fileVars = fs.existsSync(filePath)
    ? parseEnvFile(fs.readFileSync(filePath, "utf-8"))
    : {};
  return { ...process.env, ...fileVars, ...overrides };
}

// ── Subcommand entry ──────────────────────────────────────────────────────────

interface SubEntry {
  scope: string;
  extraArgs: string[];
  extraEnv: Record<string, string>;
}

/** Convert scopeSelections into a flat list of CLI invocations. */
function buildSubEntries(scopeSelections: ScopeSelection[]): SubEntry[] {
  const entries: SubEntry[] = [];

  for (const { scope, items } of scopeSelections) {
    const hasFilter = items && items.length > 0;

    if (!hasFilter) {
      // No filter — push everything in this scope
      entries.push({ scope, extraArgs: [], extraEnv: {} });
    } else if ((FILENAME_FILTER_SCOPES as readonly string[]).includes(scope)) {
      // Pass comma-separated filenames via filenameFilter env var (one run)
      entries.push({ scope, extraArgs: [], extraEnv: { filenameFilter: items!.join(",") } });
    } else if ((NAME_FLAG_SCOPES as readonly string[]).includes(scope)) {
      // --name accepts one value — run once per selected item
      for (const item of items!) {
        entries.push({ scope, extraArgs: ["--name", item], extraEnv: {} });
      }
    } else {
      // Scope doesn't support item-level filtering — push whole scope
      entries.push({ scope, extraArgs: [], extraEnv: {} });
    }
  }

  return entries;
}

// ── Retry config ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;         // up to 3 total attempts
const RETRY_DELAY_MS = 3000;   // 3 seconds between retries
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── spawnFrConfig ─────────────────────────────────────────────────────────────

export function spawnFrConfig(options: RunOptions & { envOverrides?: Record<string, string>; globalArgs?: string[] }): {
  stream: ReadableStream<string>;
  abort: () => void;
} {
  const { command, environment, scopes, scopeSelections, envOverrides, globalArgs = [] } = options;
  const baseEnv = buildEnv(environment, envOverrides);

  // Build the list of CLI invocations
  const subEntries: SubEntry[] = scopeSelections
    ? buildSubEntries(scopeSelections)
    : (scopes ?? []).map((scope) => ({ scope, extraArgs: [], extraEnv: {} }));

  let currentProc: ReturnType<typeof spawn> | null = null;
  let aborted = false;
  // Hoisted so `cancel()` can clear the heartbeat too. Set once `start`
  // runs and the controller is in scope.
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<string>({
    async start(controller) {
      const encode = (data: string, type: "stdout" | "stderr") => {
        controller.enqueue(JSON.stringify({ type, data, ts: Date.now() }) + "\n");
      };

      // Browser fetch readers drop the streaming response if no bytes flow
      // for too long (Chrome's "TypeError: network error" — usually within
      // ~30s of silence). When a single AIC PUT inside the dispatcher
      // hangs, no log line is emitted between "  PUT <url>" and the
      // restClient timeout firing 60s later, so the browser bails before
      // we ever get the ECONNABORTED that would tell us which URL stalled.
      // Tick a tiny `heartbeat` event every 10s to keep the connection
      // open. Client filters these out of the visible log.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(JSON.stringify({ type: "heartbeat", ts: Date.now() }) + "\n");
        } catch {
          // Stream already closed — let the cleanup below handle it.
        }
      }, 10_000);

      let anyFailed = false;

      // Acquire one bearer token at the start of the run and reuse it for
      // every scope. Tokens are valid for ~15 min, so there's no reason to
      // re-mint mid-run. If the tenant returns 401/403, the outer retry loop
      // passes force=true to `refreshToken` and we re-acquire on demand.
      let sharedToken: string | undefined;
      const refreshToken = async (force = false): Promise<string | undefined> => {
        if (!force && sharedToken) return sharedToken;
        try {
          sharedToken = await getAccessToken(
            baseEnv as Record<string, string>,
            (msg) => encode(`[token] ${msg}\n`, "stderr"),
          );
        } catch (err) {
          encode(`token acquisition failed: ${err instanceof Error ? err.message : String(err)}\n`, "stderr");
          sharedToken = undefined;
        }
        return sharedToken;
      };
      await refreshToken();

      // Group consecutive entries by scope so the log viewer shows one section per scope
      let currentScope: string | null = null;

      for (const entry of subEntries) {
        if (aborted) break;

        if (entry.scope !== currentScope) {
          if (currentScope !== null) {
            // Close previous scope section only if switching scopes mid-stream.
            // (scope-end is emitted when the last entry for a scope finishes below)
          }
          currentScope = entry.scope;
          controller.enqueue(
            JSON.stringify({ type: "scope-start", scope: entry.scope, ts: Date.now() }) + "\n"
          );
        }

        const procEnv = { ...baseEnv, ...entry.extraEnv };
        let exitCode: number | null = null;
        let lastStderr = "";
        let lastStdout = "";

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (aborted) break;
          if (attempt > 0) {
            encode(`Retry ${attempt}/${MAX_RETRIES} for ${entry.scope}...`, "stderr");
            await sleep(RETRY_DELAY_MS);
          }

          // Decide whether the previous attempt failed with an auth error
          // before we clear lastStderr. Only 401/403 justify burning a fresh
          // token; other failures (400, 5xx, network) retry with same token.
          const needsAuthRefresh = attempt > 0 &&
            /status code (401|403)|\bHTTP\s*(401|403)\b/i.test(lastStderr);

          lastStderr = "";
          lastStdout = "";
          const envDir = path.join(ENVIRONMENTS_DIR, environment);
          const captureEmit = (data: string, type: "stdout" | "stderr") => {
            if (type === "stdout") lastStdout += data;
            else lastStderr += data;
            encode(data, type);
          };

          const tokenForScope = await refreshToken(needsAuthRefresh);

          // Try in-process dispatch first (for fr-config-pull / fr-config-push
          // scopes we've vendored). Falls through to spawn only for frodo and
          // any scope the dispatcher doesn't handle.
          const dispatched = await dispatchFrConfig({
            command,
            scope: entry.scope,
            envVars: procEnv as Record<string, string | undefined>,
            envDir,
            extraArgs: [...globalArgs, ...entry.extraArgs],
            extraEnv: entry.extraEnv,
            emit: captureEmit,
            token: tokenForScope,
          });

          if (dispatched.handled) {
            exitCode = dispatched.code ?? 0;
          } else {
            exitCode = await new Promise<number | null>((resolve) => {
              const proc = spawn(
                command,
                [entry.scope, "--debug", ...globalArgs, ...entry.extraArgs],
                { env: procEnv, shell: true, cwd: envDir }
              );
              currentProc = proc;

              proc.stdout.on("data", (chunk: Buffer) => {
                const s = chunk.toString();
                lastStdout += s;
                encode(s, "stdout");
              });
              proc.stderr.on("data", (chunk: Buffer) => {
                const s = chunk.toString();
                lastStderr += s;
                encode(s, "stderr");
              });
              proc.on("close", (code) => { currentProc = null; resolve(code); });
              proc.on("error", (err) => {
                lastStderr += err.message;
                encode(err.message, "stderr");
                currentProc = null;
                resolve(1);
              });
            });
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

        // Emit scope-end when this scope won't appear again
        const nextEntry = subEntries[subEntries.indexOf(entry) + 1];
        if (!nextEntry || nextEntry.scope !== entry.scope) {
          const payload: Record<string, unknown> = {
            type: "scope-end",
            scope: entry.scope,
            code: exitCode,
            ts: Date.now(),
          };
          if (benignReason) payload.warning = benignReason;
          controller.enqueue(JSON.stringify(payload) + "\n");
        }
      }

      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      controller.enqueue(
        JSON.stringify({ type: "exit", code: aborted ? 130 : (anyFailed ? 1 : 0), ts: Date.now() }) + "\n"
      );
      controller.close();
    },
    cancel() {
      aborted = true;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      currentProc?.kill("SIGTERM");
    },
  });

  return {
    stream,
    abort: () => {
      aborted = true;
      currentProc?.kill("SIGTERM");
    },
  };
}

// ── DiffSummary (moved to src/lib/compare.ts) ─────────────────────────────
export type { DiffSummary } from "@/lib/compare";
