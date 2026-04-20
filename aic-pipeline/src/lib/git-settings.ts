import { execSync } from "child_process";
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
  targetDir: "environments",
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

export function runGit(args: string[], cwd: string, timeoutMs = 30_000): RunResult {
  try {
    const stdout = execSync(`git ${args.map(shellQuote).join(" ")}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "", code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number; message?: string };
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message ?? "",
      code: err.status ?? 1,
    };
  }
}

function shellQuote(s: string): string {
  if (s === "") return '""';
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
