import { loadSettings, resolveTargetDir, targetHasGit, runGit } from "@/lib/git-settings";
import { appendOpLog } from "@/lib/op-history";
import type { OpEventSink, OpResult } from "@/lib/operations/types";

export interface RunGitPushOpts {
  message?: string;
  force?: boolean;
  trigger?: "manual" | "scheduled";
  scheduleId?: string;
}

export async function runGitPush(opts: RunGitPushOpts, emit: OpEventSink): Promise<OpResult> {
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();
  const settings = loadSettings();

  const finish = (status: "success" | "failed", summary: string, error?: string): OpResult => {
    let runId: string | undefined;
    try {
      runId = appendOpLog({
        type: "push",
        environment: "(repo)",
        scopes: [],
        status,
        startedAt,
        durationMs: Date.now() - startTime,
        summary,
        trigger: opts.trigger,
        scheduleId: opts.scheduleId,
      }).id;
    } catch { /* non-fatal */ }
    return { status, summary, durationMs: Date.now() - startTime, error, runId };
  };

  if (!targetHasGit(settings)) {
    emit({ type: "git", action: "push-error", message: "Target directory is not a git repository", ts: Date.now() });
    return finish("failed", "Not a git repository", "Target directory is not a git repository");
  }

  const cwd = resolveTargetDir(settings);
  const branch = settings.branch || "main";

  const status = runGit(["status", "--porcelain"], cwd);
  const dirty = status.code === 0 && status.stdout.trim().length > 0;
  if (dirty) {
    const add = runGit(["add", "-A"], cwd);
    if (add.code !== 0) {
      emit({ type: "git", action: "add-error", message: add.stderr, ts: Date.now() });
      return finish("failed", "git add failed", add.stderr);
    }
    const message = opts.message ?? `chore(scheduler): scheduled commit @ ${startedAt}`;
    const commit = runGit(["commit", "-m", message], cwd);
    if (commit.code !== 0) {
      emit({ type: "git", action: "commit-error", message: commit.stderr, ts: Date.now() });
      return finish("failed", "git commit failed", commit.stderr);
    }
    emit({ type: "git", action: "commit", message: `Committed: ${message}`, ts: Date.now() });
  } else {
    emit({ type: "git", action: "clean", message: "Working tree clean — nothing to commit", ts: Date.now() });
  }

  const pushArgs = ["push", ...(opts.force ? ["--force-with-lease"] : []), "origin", branch];
  const push = runGit(pushArgs, cwd);
  if (push.code !== 0) {
    emit({ type: "git", action: "push-error", message: push.stderr, ts: Date.now() });
    return finish("failed", "git push failed", push.stderr);
  }
  emit({ type: "git", action: "push", message: `Pushed to origin/${branch}`, ts: Date.now() });
  return finish("success", dirty ? "Committed and pushed" : "Pushed (no new commit)");
}
