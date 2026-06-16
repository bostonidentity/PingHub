import path from "path";
import { spawnFrConfig, ConfigScope, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { autoCommit, analyzeChanges, pruneScopeDirs, scopeLabel as getScopeLabel } from "@/lib/git";
import { ENVIRONMENTS_DIR } from "@/lib/paths";
import { appendOpLog, type OpMetadata } from "@/lib/op-history";
import { CONFIG_SCOPES } from "@/lib/fr-config-types";
import { spawnFrodo, FRODO_SCOPES } from "@/lib/frodo";
import { runIgaApi, IGA_API_SCOPES } from "@/lib/iga-api";
import { mergeRunnerStreams } from "@/lib/operations/merge-streams";
import type { OpEvent, OpEventSink, OpResult } from "@/lib/operations/types";

export interface RunSyncOpts {
  environment: string;
  scopes?: ConfigScope[];
  trigger?: "manual" | "scheduled";
  scheduleId?: string;
}

export async function runSync(opts: RunSyncOpts, emit: OpEventSink): Promise<OpResult> {
  const { environment, scopes } = opts;
  const scopesList = scopes ?? [];
  const scopeLabel = scopesList.length ? scopesList.join(", ") : "all";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const envVars = parseEnvFile(getEnvFileContent(environment));
  const configDirRel = envVars.CONFIG_DIR ?? "./config";

  let preHash: string | null = null;
  let preCommitError: string | null = null;
  try {
    preHash = autoCommit(environment, `auto: save uncommitted changes for ${environment} before pull`, configDirRel);
  } catch (err) {
    preCommitError = err instanceof Error ? err.message : String(err);
  }

  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  if (preCommitError) {
    emit({ type: "git", action: "pre-pull-commit-error", message: `Git commit failed — pull aborted: ${preCommitError}`, ts: Date.now() });
    const summary = `Pull aborted: ${preCommitError}`;
    let runId: string | undefined;
    try {
      runId = appendOpLog({ type: "pull", environment, scopes: scopesList.length ? scopesList : ["all"], status: "failed", startedAt, durationMs: Date.now() - startTime, summary, trigger: opts.trigger, scheduleId: opts.scheduleId }).id;
    } catch { /* non-fatal */ }
    return { status: "failed", summary, durationMs: Date.now() - startTime, error: preCommitError, runId };
  }

  const allScopes = scopesList.length
    ? scopesList
    : (CONFIG_SCOPES.filter((s) => s.cliSupported !== false).map((s) => s.value) as ConfigScope[]);

  const configDirAbs = path.resolve(ENVIRONMENTS_DIR, environment, configDirRel);
  let prunedDirs: string[] = [];
  let pruneError: string | null = null;
  try {
    prunedDirs = pruneScopeDirs(configDirAbs, allScopes);
  } catch (err) {
    pruneError = err instanceof Error ? err.message : String(err);
  }

  const frodoScopes = allScopes.filter((s) => FRODO_SCOPES.includes(s));
  const igaScopes = allScopes.filter((s) => IGA_API_SCOPES.includes(s));
  const frScopes = allScopes.filter((s) => !FRODO_SCOPES.includes(s) && !IGA_API_SCOPES.includes(s)) as ConfigScope[];

  const streams: ReadableStream<string>[] = [];
  if (frScopes.length) streams.push(spawnFrConfig({ command: "fr-config-pull", environment, scopes: frScopes }).stream);
  if (frodoScopes.length) streams.push(spawnFrodo({ command: "fr-config-pull", environment, scopes: frodoScopes }).stream);
  if (igaScopes.length) streams.push(runIgaApi({ command: "fr-config-pull", environment, scopes: igaScopes }).stream);

  if (preHash) emit({ type: "git", action: "pre-pull-commit", hash: preHash, message: `Committed uncommitted changes before pull (${preHash})`, ts: Date.now() });
  else emit({ type: "git", action: "pre-pull-clean", message: "No uncommitted changes — working tree clean", ts: Date.now() });

  if (pruneError) emit({ type: "git", action: "pre-pull-prune-error", message: `Failed to prune scope directories: ${pruneError}`, ts: Date.now() });
  else if (prunedDirs.length === 0) emit({ type: "git", action: "pre-pull-prune-skip", message: "No existing scope directories to prune", ts: Date.now() });
  else for (const dir of prunedDirs) emit({ type: "git", action: "pre-pull-prune", message: `Pruned ${path.relative(process.cwd(), dir)}`, ts: Date.now() });

  const pullStream = mergeRunnerStreams(streams);
  const reader = pullStream.getReader();
  let lastExitCode = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split("\n")) {
      if (!line.trim()) continue;
      let parsed: OpEvent;
      try { parsed = JSON.parse(line) as OpEvent; } catch { continue; }
      if (parsed.type === "exit") { lastExitCode = (parsed.code as number) ?? 0; continue; }
      emit(parsed);
    }
  }

  let summary = "Pull failed";
  if (lastExitCode === 0) {
    const changes = analyzeChanges(environment, configDirRel);
    let added = 0, modified = 0, deleted = 0;
    for (const c of changes) { added += c.added.length; modified += c.modified.length; deleted += c.deleted.length; }
    const totalItems = added + modified + deleted;
    const scopeNames = changes.map((c) => getScopeLabel(c.scope)).join(", ");
    summary = totalItems > 0 ? `${totalItems} items across ${changes.length} scope${changes.length !== 1 ? "s" : ""} (${scopeNames})` : "No changes";
    try {
      const metadata: OpMetadata = { operation: "pull", environment, scopes: scopesList.length ? scopesList : ["all"], status: "success", startedAt, durationMs: Date.now() - startTime, added, modified, deleted };
      const postHash = autoCommit(environment, `pull(${environment}): ${scopeLabel} @ ${ts}`, configDirRel, metadata);
      if (postHash) emit({ type: "git", action: "post-pull-commit", hash: postHash, message: `Auto-committed pull results (${postHash})`, ts: Date.now() });
      else emit({ type: "git", action: "post-pull-clean", message: "No changes from pull — nothing to commit", ts: Date.now() });
    } catch (err) {
      emit({ type: "git", action: "post-pull-commit-error", message: `Git commit failed after pull: ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() });
    }
  }

  let runId: string | undefined;
  try {
    runId = appendOpLog({ type: "pull", environment, scopes: scopesList.length ? scopesList : ["all"], status: lastExitCode === 0 ? "success" : "failed", startedAt, durationMs: Date.now() - startTime, summary, trigger: opts.trigger, scheduleId: opts.scheduleId }).id;
  } catch { /* non-fatal */ }

  return { status: lastExitCode === 0 ? "success" : "failed", summary, durationMs: Date.now() - startTime, runId, error: lastExitCode === 0 ? undefined : summary };
}
