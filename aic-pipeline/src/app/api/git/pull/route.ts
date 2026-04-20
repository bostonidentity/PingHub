import { NextResponse } from "next/server";
import { loadSettings, resolveTargetDir, targetHasGit, runGit } from "@/lib/git-settings";

export async function POST() {
  const settings = loadSettings();
  if (!targetHasGit(settings)) {
    return NextResponse.json({ ok: false, error: "Target is not a git repo." }, { status: 400 });
  }
  const cwd = resolveTargetDir(settings);
  const res = runGit(["pull", "--ff-only", "origin", settings.branch], cwd, 120_000);
  return NextResponse.json({
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
  });
}
