import { NextRequest, NextResponse } from "next/server";
import { loadSettings, resolveTargetDir, targetHasGit, runGit } from "@/lib/git-settings";

export async function POST(req: NextRequest) {
  const settings = loadSettings();
  if (!targetHasGit(settings)) {
    return NextResponse.json({ ok: false, error: "Target is not a git repo." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Manual snapshot from Settings";

  const cwd = resolveTargetDir(settings);

  const statusRes = runGit(["status", "--porcelain"], cwd);
  if (!statusRes.ok) {
    return NextResponse.json({ ok: false, error: statusRes.stderr }, { status: 500 });
  }
  if (!statusRes.stdout.trim()) {
    return NextResponse.json({ ok: false, error: "Nothing to commit." }, { status: 400 });
  }

  const add = runGit(["add", "-A"], cwd);
  if (!add.ok) return NextResponse.json({ ok: false, error: add.stderr }, { status: 500 });

  const commit = runGit(["commit", "-m", message], cwd);
  if (!commit.ok) return NextResponse.json({ ok: false, error: commit.stderr }, { status: 500 });

  const hashRes = runGit(["rev-parse", "--short", "HEAD"], cwd);
  return NextResponse.json({ ok: true, hash: hashRes.ok ? hashRes.stdout : null });
}
