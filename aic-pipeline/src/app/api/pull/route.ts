import { NextRequest } from "next/server";
import path from "path";
import { spawnFrConfig, ConfigScope, getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import { autoCommit, analyzeChanges, pruneScopeDirs, scopeLabel as getScopeLabel } from "@/lib/git";
import { appendOpLog, type OpMetadata } from "@/lib/op-history";
import { CONFIG_SCOPES } from "@/lib/fr-config-types";
import { spawnFrodo, FRODO_SCOPES } from "@/lib/frodo";
import { runIgaApi, IGA_API_SCOPES } from "@/lib/iga-api";

/** Concatenate multiple streams sequentially into one, emitting a single final exit event. */
function mergeStreams(streams: ReadableStream<string>[]): ReadableStream<string> {
  if (streams.length === 1) return streams[0];
  return new ReadableStream<string>({
    async start(controller) {
      let lastCode = 0;
      for (const s of streams) {
        const reader = s.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Re-emit everything except the exit line from sub-streams
          for (const line of value.split("\n")) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line) as { type: string; code?: number };
              if (p.type === "exit") { lastCode = Math.max(lastCode, p.code ?? 0); continue; }
            } catch { /* pass through */ }
            controller.enqueue(line + "\n");
          }
        }
      }
      controller.enqueue(JSON.stringify({ type: "exit", code: lastCode, ts: Date.now() }) + "\n");
      controller.close();
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { environment, scopes } = body as {
    environment: string;
    scopes?: ConfigScope[];
  };

  if (!environment) {
    return new Response("Missing environment", { status: 400 });
  }

  const scopesList = scopes ?? [];
  const scopeLabel = scopesList.length ? scopesList.join(", ") : "all";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  // Resolve CONFIG_DIR from .env for change analysis
  const envVars = parseEnvFile(getEnvFileContent(environment));
  const configDirRel = envVars.CONFIG_DIR ?? "./config";

  // Pre-pull: commit any existing uncommitted changes
  let preHash: string | null = null;
  let preCommitError: string | null = null;
  try {
    preHash = autoCommit(
      environment,
      `auto: save uncommitted changes for ${environment} before pull`,
      configDirRel
    );
  } catch (err) {
    preCommitError = err instanceof Error ? err.message : String(err);
  }

  // If the pre-pull commit failed, abort — return an error stream instead of pulling
  if (preCommitError) {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(
          JSON.stringify({
            type: "git",
            action: "pre-pull-commit-error",
            message: `Git commit failed — pull aborted: ${preCommitError}`,
            ts: Date.now(),
          }) + "\n"
        );
        controller.enqueue(
          JSON.stringify({ type: "exit", code: 1, ts: Date.now() }) + "\n"
        );
        controller.close();
      },
    });

    return new Response(stream as unknown as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Partition scopes by command type
  const allScopes = scopesList.length ? scopesList : (CONFIG_SCOPES.filter(s => s.cliSupported !== false).map(s => s.value) as ConfigScope[]);

  // Prune: delete on-disk scope directories so the pull mirrors remote deletions.
  // Safe because the pre-pull auto-commit above just snapshotted any local changes.
  const configDirAbs = path.resolve(process.cwd(), "environments", environment, configDirRel);
  let prunedDirs: string[] = [];
  let pruneError: string | null = null;
  try {
    prunedDirs = pruneScopeDirs(configDirAbs, allScopes);
  } catch (err) {
    pruneError = err instanceof Error ? err.message : String(err);
  }

  const frodoScopes = allScopes.filter((s) => FRODO_SCOPES.includes(s));
  const igaScopes   = allScopes.filter((s) => IGA_API_SCOPES.includes(s));
  const frScopes    = allScopes.filter((s) => !FRODO_SCOPES.includes(s) && !IGA_API_SCOPES.includes(s)) as ConfigScope[];

  // Build a combined stream from all runners
  const streams: ReadableStream<string>[] = [];
  if (frScopes.length)   streams.push(spawnFrConfig({ command: "fr-config-pull", environment, scopes: frScopes }).stream);
  if (frodoScopes.length) streams.push(spawnFrodo({ command: "fr-config-pull", environment, scopes: frodoScopes }).stream);
  if (igaScopes.length)   streams.push(runIgaApi({ command: "fr-config-pull", environment, scopes: igaScopes }).stream);

  const pullStream = mergeStreams(streams);

  // Wrap the pull stream to inject git events before and after
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  const stream = new ReadableStream<string>({
    async start(controller) {
      const emit = (data: object) => {
        controller.enqueue(JSON.stringify(data) + "\n");
      };

      // Emit pre-pull commit result
      if (preHash) {
        emit({
          type: "git",
          action: "pre-pull-commit",
          hash: preHash,
          message: `Committed uncommitted changes before pull (${preHash})`,
          ts: Date.now(),
        });
      } else {
        emit({
          type: "git",
          action: "pre-pull-clean",
          message: "No uncommitted changes — working tree clean",
          ts: Date.now(),
        });
      }

      // Emit prune events so the UI shows what was wiped to mirror remote deletions
      if (pruneError) {
        emit({
          type: "git",
          action: "pre-pull-prune-error",
          message: `Failed to prune scope directories: ${pruneError}`,
          ts: Date.now(),
        });
      } else if (prunedDirs.length === 0) {
        emit({
          type: "git",
          action: "pre-pull-prune-skip",
          message: "No existing scope directories to prune",
          ts: Date.now(),
        });
      } else {
        for (const dir of prunedDirs) {
          emit({
            type: "git",
            action: "pre-pull-prune",
            message: `Pruned ${path.relative(process.cwd(), dir)}`,
            ts: Date.now(),
          });
        }
      }

      // Pipe through the pull stream
      const reader = pullStream.getReader();
      let lastExitCode = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
        // Parse for exit code
        for (const line of value.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "exit") lastExitCode = parsed.code;
          } catch {
            // ignore
          }
        }
      }

      // Post-pull: commit and record history
      let summary = "Pull failed";
      let postHash: string | null = null;
      let totalAdded = 0;
      let totalModified = 0;
      let totalDeleted = 0;

      if (lastExitCode === 0) {
        // Capture changes BEFORE commit (commit cleans the working tree)
        const changes = analyzeChanges(environment, configDirRel);

        for (const c of changes) {
          totalAdded += c.added.length;
          totalModified += c.modified.length;
          totalDeleted += c.deleted.length;
        }
        const totalItems = totalAdded + totalModified + totalDeleted;
        const scopeNames = changes.map((c) => getScopeLabel(c.scope)).join(", ");
        summary = totalItems > 0
          ? `${totalItems} items across ${changes.length} scope${changes.length !== 1 ? "s" : ""} (${scopeNames})`
          : "No changes";

        try {
          const metadata: OpMetadata = {
            operation: "pull",
            environment,
            scopes: scopesList.length ? scopesList : ["all"],
            status: "success",
            startedAt,
            durationMs: Date.now() - startTime,
            added: totalAdded,
            modified: totalModified,
            deleted: totalDeleted,
          };
          postHash = autoCommit(
            environment,
            `pull(${environment}): ${scopeLabel} @ ${ts}`,
            configDirRel,
            metadata,
          );
          if (postHash) {
            emit({
              type: "git",
              action: "post-pull-commit",
              hash: postHash,
              message: `Auto-committed pull results (${postHash})`,
              ts: Date.now(),
            });
          } else {
            emit({
              type: "git",
              action: "post-pull-clean",
              message: "No changes from pull — nothing to commit",
              ts: Date.now(),
            });
          }
        } catch (err) {
          const postCommitError = err instanceof Error ? err.message : String(err);
          emit({
            type: "git",
            action: "post-pull-commit-error",
            message: `Git commit failed after pull: ${postCommitError}`,
            ts: Date.now(),
          });
        }
      }

      // Always record to op-log so every pull is visible in history
      // (git-commit history is a secondary source parsed from trailers)
      try {
        appendOpLog({
          type: "pull",
          environment,
          scopes: scopesList.length ? scopesList : ["all"],
          status: lastExitCode === 0 ? "success" : "failed",
          startedAt,
          durationMs: Date.now() - startTime,
          summary,
        });
      } catch {
        // non-fatal
      }

      controller.close();
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
