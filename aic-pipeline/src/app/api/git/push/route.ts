import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import {
  loadSettings,
  resolveTargetDir,
  targetHasGit,
  runGit,
  GitSettings,
} from "@/lib/git-settings";

interface PreflightResult {
  reason: "not-initialized" | "branch-mismatch" | "no-commits";
  currentBranch?: string;
  dirtyCount?: number;
  message: string;
}

export async function POST(req: NextRequest) {
  const settings = loadSettings();
  const cwd = resolveTargetDir(settings);
  const body = await req.json().catch(() => ({}));
  const confirmed = body.confirm === true;

  if (!fs.existsSync(cwd)) {
    return NextResponse.json(
      { ok: false, error: `Target dir does not exist: ${cwd}` },
      { status: 400 },
    );
  }
  if (!settings.remoteUrl) {
    return NextResponse.json({ ok: false, error: "Remote URL is required." }, { status: 400 });
  }

  const preflight = detectSetupNeed(cwd, settings);

  if (preflight && !confirmed) {
    return NextResponse.json({
      ok: false,
      needsConfirm: true,
      preflight,
    });
  }

  if (preflight) {
    const applied = applySetup(cwd, settings, preflight);
    if (!applied.ok) {
      return NextResponse.json({ ok: false, error: applied.error, steps: applied.steps }, { status: 500 });
    }
  }

  const pushRes = runGit(["push", "-u", "origin", settings.branch], cwd, 120_000);
  return NextResponse.json({
    ok: pushRes.ok,
    stdout: pushRes.stdout,
    stderr: pushRes.stderr,
  });
}

function detectSetupNeed(cwd: string, settings: GitSettings): PreflightResult | null {
  if (!targetHasGit(settings)) {
    const dirtyCount = countDirty(cwd, false);
    return {
      reason: "not-initialized",
      dirtyCount,
      message: `"${settings.targetDir}" is not a git repository yet. Initialize it, commit all ${dirtyCount} file(s), and push to origin/${settings.branch}?`,
    };
  }

  const headRes = runGit(["rev-parse", "--verify", "HEAD"], cwd);
  if (!headRes.ok) {
    const dirtyCount = countDirty(cwd, true);
    return {
      reason: "no-commits",
      dirtyCount,
      message: `Branch "${settings.branch}" has no commits yet. Commit ${dirtyCount} file(s) as an initial snapshot and push?`,
    };
  }

  const branchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const currentBranch = branchRes.ok ? branchRes.stdout : "";
  if (currentBranch && currentBranch !== settings.branch) {
    return {
      reason: "branch-mismatch",
      currentBranch,
      message: `Current branch is "${currentBranch}" but settings target "${settings.branch}". Create and switch to "${settings.branch}" before pushing?`,
    };
  }

  return null;
}

interface ApplyResult {
  ok: boolean;
  error?: string;
  steps: { cmd: string; ok: boolean; out: string }[];
}

function applySetup(cwd: string, settings: GitSettings, preflight: PreflightResult): ApplyResult {
  const steps: ApplyResult["steps"] = [];
  const run = (args: string[]) => {
    const res = runGit(args, cwd);
    steps.push({ cmd: `git ${args.join(" ")}`, ok: res.ok, out: res.ok ? res.stdout : res.stderr });
    return res;
  };

  if (preflight.reason === "not-initialized") {
    if (!run(["init", "-b", settings.branch]).ok) return { ok: false, error: "git init failed", steps };
    if (settings.authorName) run(["config", "user.name", settings.authorName]);
    if (settings.authorEmail) run(["config", "user.email", settings.authorEmail]);
    if (!run(["remote", "add", "origin", settings.remoteUrl]).ok)
      return { ok: false, error: "git remote add failed", steps };
  }

  if (preflight.reason === "branch-mismatch") {
    const created = run(["checkout", "-b", settings.branch]);
    if (!created.ok) {
      const switched = run(["checkout", settings.branch]);
      if (!switched.ok) return { ok: false, error: created.stderr || "checkout failed", steps };
    }
  }

  const dirty = runGit(["status", "--porcelain"], cwd);
  if (dirty.ok && dirty.stdout.trim()) {
    if (!run(["add", "-A"]).ok) return { ok: false, error: "git add failed", steps };
    const commitMsg =
      preflight.reason === "not-initialized"
        ? "Initial environments snapshot"
        : "Snapshot before push";
    if (!run(["commit", "-m", commitMsg]).ok) return { ok: false, error: "git commit failed", steps };
  }

  return { ok: true, steps };
}

function countDirty(cwd: string, requireGit: boolean): number {
  if (requireGit) {
    const res = runGit(["status", "--porcelain"], cwd);
    if (!res.ok) return 0;
    return res.stdout.split("\n").filter((l) => l.trim()).length;
  }
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else count++;
    }
  };
  try {
    walk(cwd);
  } catch {
    /* ignore */
  }
  return count;
}
