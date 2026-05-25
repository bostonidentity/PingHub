import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

import {
  loadSettings,
  resolveTargetDir,
  runGit,
  runGitStream,
  targetHasGit,
  type StreamHandle,
} from "@/lib/git-settings";

/**
 * POST /api/git/commit
 * Body: { message?: string }
 * Streams Server-Sent Events:
 *   - step       (one-shot completed step)
 *   - step-start (long-running git command starting)
 *   - progress   (line of stdout/stderr from the running git command)
 *   - step-end   (long-running git command finished)
 *   - done       ({ ok, cancelled, error?, hash? })
 *
 * DELETE /api/git/commit cancels the in-flight commit (SIGKILL on the active
 * git child). After a cancel, any leftover `.git/index.lock` is removed on
 * the *next* commit attempt so the user can re-commit immediately.
 */

interface StreamStep {
  cmd: string;
  ok: boolean | null;
  out: string;
}

interface JobRef {
  cancel: () => void;
}
let CURRENT_JOB: JobRef | null = null;

export async function POST(req: NextRequest) {
  const settings = loadSettings();
  if (!targetHasGit(settings)) {
    return NextResponse.json(
      { ok: false, error: "Target is not a git repo." },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Manual snapshot from Settings";

  const cwd = resolveTargetDir(settings);

  if (CURRENT_JOB) {
    return NextResponse.json(
      { ok: false, error: "A commit is already in progress. Cancel it or wait." },
      { status: 409 },
    );
  }

  return runCommitStream({ cwd, message });
}

export async function DELETE() {
  if (!CURRENT_JOB) {
    return NextResponse.json({ ok: false, error: "No commit in progress." }, { status: 404 });
  }
  CURRENT_JOB.cancel();
  return NextResponse.json({ ok: true });
}

interface RunCommitArgs {
  cwd: string;
  message: string;
}

function runCommitStream({ cwd, message }: RunCommitArgs): Response {
  const encoder = new TextEncoder();
  const steps: StreamStep[] = [];
  let cancelled = false;
  let activeStream: StreamHandle | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* client disconnected */
        }
      };

      CURRENT_JOB = {
        cancel: () => {
          cancelled = true;
          activeStream?.cancel();
        },
      };

      const stepOnce = (args: string[]) => {
        const res = runGit(args, cwd);
        const step: StreamStep = {
          cmd: `git ${args.join(" ")}`,
          ok: res.ok,
          out: res.ok ? res.stdout : res.stderr,
        };
        steps.push(step);
        send("step", step);
        return res;
      };

      const stepStream = (args: string[], timeoutMs?: number) => {
        const cmd = `git ${args.join(" ")}`;
        send("step-start", { cmd });
        let outBuf = "";
        const handle = runGitStream(args, cwd, (kind, line) => {
          outBuf += line + "\n";
          send("progress", { kind, line });
        });
        activeStream = handle;
        const timer = timeoutMs
          ? setTimeout(() => {
            if (!cancelled) {
              send("progress", {
                kind: "stderr",
                line: `(timeout: killing git after ${timeoutMs}ms)`,
              });
            }
            handle.cancel();
          }, timeoutMs)
          : null;
        return handle.done.then(({ code, killed }) => {
          if (timer) clearTimeout(timer);
          activeStream = null;
          const ok = code === 0 && !killed;
          const step: StreamStep = { cmd, ok, out: outBuf.trim() };
          steps.push(step);
          send("step-end", step);
          return { ok, code, killed };
        });
      };

      const finish = (data: {
        ok: boolean;
        cancelled?: boolean;
        error?: string;
        hash?: string | null;
      }) => {
        send("done", data);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        CURRENT_JOB = null;
      };

      const fail = (label: string) => {
        const last = steps[steps.length - 1];
        const detail = last?.out?.trim();
        const error = detail ? `${label}: ${detail.split("\n")[0]}` : label;
        finish({ ok: false, cancelled, error });
      };

      try {
        // ---- 1. Clear stale lock from any previously-aborted commit ----
        clearStaleIndexLock(cwd, (s) => {
          steps.push(s);
          send("step", s);
        });

        // ---- 2. Status check (cheap) ----
        const status = stepOnce(["status", "--porcelain"]);
        if (!status.ok) return fail("git status failed");
        if (!status.stdout.trim()) {
          return finish({ ok: false, error: "Nothing to commit." });
        }
        const dirtyCount = status.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
        send("step", {
          cmd: `(staging ${dirtyCount} change${dirtyCount === 1 ? "" : "s"})`,
          ok: true,
          out: "",
        });

        if (cancelled) return fail("Cancelled");

        // ---- 3. Stage all (streamed; can take a while on big repos) ----
        const addArgs = [
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.safecrlf=false",
          "-c",
          "core.longpaths=true",
          "add",
          "-A",
        ];
        const addRes = await stepStream(addArgs, 10 * 60 * 1000);
        if (!addRes.ok) {
          if (cancelled) return fail("Cancelled");
          const last = steps[steps.length - 1];
          if (last && /index\.lock.*File exists/i.test(last.out)) {
            return fail(
              "git add failed: another git process is holding .git/index.lock",
            );
          }
          return fail("git add failed");
        }

        if (cancelled) return fail("Cancelled");

        // ---- 4. Commit ----
        const commitRes = await stepStream(
          ["-c", "gc.auto=0", "commit", "-m", message],
        );
        if (!commitRes.ok) {
          // Auto-gc on Windows sometimes poisons the exit code even though
          // the commit landed. Verify by checking HEAD.
          const head = runGit(["log", "-1", "--pretty=%s"], cwd);
          if (!(head.ok && head.stdout.trim() === message)) {
            if (cancelled) return fail("Cancelled");
            return fail("git commit failed");
          }
        }

        const hashRes = runGit(["rev-parse", "--short", "HEAD"], cwd);
        return finish({
          ok: true,
          hash: hashRes.ok ? hashRes.stdout : null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return finish({ ok: false, cancelled, error: msg });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Remove a stale `.git/index.lock`. Mirrors the helper in /api/git/push.
 * Only removes locks older than 5 s to avoid racing a legitimate concurrent
 * git invocation. After a SIGKILL'd commit on Windows the lock is left at
 * mtime ~= "kill time", so the next commit (any time after 5 s) will pass.
 */
function clearStaleIndexLock(cwd: string, emit: (s: StreamStep) => void): void {
  const lock = path.join(cwd, ".git", "index.lock");
  try {
    const stat = fs.statSync(lock);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 5_000) return;
    fs.unlinkSync(lock);
    emit({
      cmd: "rm .git/index.lock (stale)",
      ok: true,
      out: `removed lock file (age ${Math.round(ageMs / 1000)}s)`,
    });
  } catch {
    /* no lock or can't unlink — let git report */
  }
}
