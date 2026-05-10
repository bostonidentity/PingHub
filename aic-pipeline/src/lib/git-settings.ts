import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const REPO_ROOT = process.cwd();
const SETTINGS_PATH = path.join(REPO_ROOT, "git-settings.json");

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
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: Partial<GitSettings>): GitSettings {
  const merged = { ...loadSettings(), ...next };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

export function resolveTargetDir(settings: GitSettings = loadSettings()): string {
  return path.isAbsolute(settings.targetDir)
    ? settings.targetDir
    : path.join(REPO_ROOT, settings.targetDir);
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
