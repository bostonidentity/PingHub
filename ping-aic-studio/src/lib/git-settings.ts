import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// The Next.js standalone server (`.next/standalone/server.js`) calls
// `process.chdir(__dirname)` on startup, so by the time this module loads
// `process.cwd()` is `<app>/.next/standalone/` — not the app dir we want.
// The launcher exports `PINGHUB_APP_DIR` so we can recover the real root.
// Evaluated lazily on each call so tests that `process.chdir` still work.
function repoRoot(): string {
  return process.env.PINGHUB_APP_DIR || process.cwd();
}

function settingsPath(): string {
  return path.join(repoRoot(), "git-settings.json");
}

export interface GitSettings {
  remoteUrl: string;
  branch: string;
  targetDir: string;
  authorName: string;
  authorEmail: string;
  autoPush: boolean;
  commitTemplate: string;
}

const DEFAULT_SETTINGS: GitSettings = {
  remoteUrl: "",
  branch: "main",
  targetDir: "../environments",
  authorName: "",
  authorEmail: "",
  autoPush: false,
  commitTemplate: "{op}({tenant}): {scopes} @ {timestamp}",
};

export function loadSettings(): GitSettings {
  const p = settingsPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: Partial<GitSettings>): GitSettings {
  const merged = { ...loadSettings(), ...next };
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

export function resolveTargetDir(settings: GitSettings = loadSettings()): string {
  return path.isAbsolute(settings.targetDir)
    ? settings.targetDir
    : path.join(repoRoot(), settings.targetDir);
}

export function targetHasGit(settings: GitSettings = loadSettings()): boolean {
  return fs.existsSync(path.join(resolveTargetDir(settings), ".git"));
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export function runGit(args: string[], cwd: string, timeoutMs = 120_000): RunResult {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    // SIGTERM is mapped to a polite shutdown on Windows that git often ignores,
    // leaving an index.lock behind and blocking the next call. SIGKILL maps to
    // TerminateProcess which actually kills it.
    killSignal: "SIGKILL",
  });
  if (res.error) {
    const anyErr = res.error as NodeJS.ErrnoException & { code?: string };
    const isTimeout = anyErr.code === "ETIMEDOUT" || res.signal === "SIGKILL" || res.signal === "SIGTERM";
    return {
      ok: false,
      stdout: (res.stdout ?? "").toString(),
      stderr:
        (res.stderr ?? "").toString() ||
        (isTimeout ? `git ${args[0] ?? ""} timed out after ${timeoutMs}ms` : anyErr.message),
      code: typeof res.status === "number" ? res.status : 1,
    };
  }
  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  const code = typeof res.status === "number" ? res.status : 1;
  if (code === 0) {
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  }
  return { ok: false, stdout, stderr: stderr.trim() || stdout.trim(), code };
}

/**
 * Spawn `git` and stream stdout/stderr line-by-line to `onLine`. Returns a
 * promise resolving to the final exit code, plus a `cancel()` function that
 * SIGKILLs the child. Used by the Push streaming endpoint to surface live
 * progress (e.g. `--progress` from `git push`).
 */
export interface StreamHandle {
  done: Promise<{ code: number; killed: boolean }>;
  cancel: () => void;
  pid: number | undefined;
}

export function runGitStream(
  args: string[],
  cwd: string,
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): StreamHandle {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      // Force git's progress output (e.g. "Counting objects: …") even though
      // stderr is a pipe, not a TTY. Without this `git push` only emits the
      // final ref-update summary.
      GIT_PROGRESS_DELAY: "0",
    },
  });

  let killed = false;
  const splitToLines = (stream: "stdout" | "stderr") => {
    let buf = "";
    return (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      // git uses \r for in-place progress updates; treat both as line breaks.
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (line.length > 0) onLine(stream, line);
      }
    };
  };
  child.stdout?.on("data", splitToLines("stdout"));
  child.stderr?.on("data", splitToLines("stderr"));

  const done = new Promise<{ code: number; killed: boolean }>((resolve) => {
    child.on("close", (code) => {
      resolve({ code: typeof code === "number" ? code : 1, killed });
    });
    child.on("error", () => {
      resolve({ code: 1, killed });
    });
  });

  return {
    done,
    pid: child.pid,
    cancel: () => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    },
  };
}
