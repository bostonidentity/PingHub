import { NextResponse } from "next/server";
import fs from "fs";
import { loadSettings, resolveTargetDir, targetHasGit, runGit } from "@/lib/git-settings";

export async function POST() {
  const settings = loadSettings();
  const cwd = resolveTargetDir(settings);

  if (!fs.existsSync(cwd)) {
    return NextResponse.json({ ok: false, error: `Target dir does not exist: ${cwd}` }, { status: 400 });
  }
  if (!settings.remoteUrl) {
    return NextResponse.json({ ok: false, error: "Remote URL is required." }, { status: 400 });
  }
  if (targetHasGit(settings)) {
    return NextResponse.json({ ok: false, error: "Already initialized." }, { status: 409 });
  }

  const steps: { cmd: string; ok: boolean; out: string }[] = [];
  const run = (args: string[]) => {
    const res = runGit(args, cwd);
    steps.push({ cmd: `git ${args.join(" ")}`, ok: res.ok, out: res.ok ? res.stdout : res.stderr });
    return res;
  };

  if (!run(["init", "-b", settings.branch]).ok) return NextResponse.json({ ok: false, steps });
  if (settings.authorName) run(["config", "user.name", settings.authorName]);
  if (settings.authorEmail) run(["config", "user.email", settings.authorEmail]);
  if (!run(["remote", "add", "origin", settings.remoteUrl]).ok) return NextResponse.json({ ok: false, steps });

  return NextResponse.json({ ok: true, steps });
}
