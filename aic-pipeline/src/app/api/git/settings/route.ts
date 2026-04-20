import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings, targetHasGit, resolveTargetDir, runGit } from "@/lib/git-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = loadSettings();
  return NextResponse.json({
    settings,
    targetDirAbsolute: resolveTargetDir(settings),
    hasGit: targetHasGit(settings),
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const allowed = [
    "remoteUrl",
    "branch",
    "targetDir",
    "authorName",
    "authorEmail",
    "autoPush",
    "commitTemplate",
  ] as const;
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) patch[key] = body[key];
  }
  const settings = saveSettings(patch);

  const syncSteps: { cmd: string; ok: boolean; out: string }[] = [];
  if (targetHasGit(settings)) {
    const cwd = resolveTargetDir(settings);
    const record = (args: string[]) => {
      const res = runGit(args, cwd);
      syncSteps.push({ cmd: `git ${args.join(" ")}`, ok: res.ok, out: res.ok ? res.stdout : res.stderr });
    };

    if (settings.remoteUrl) {
      const current = runGit(["remote", "get-url", "origin"], cwd);
      if (!current.ok) {
        record(["remote", "add", "origin", settings.remoteUrl]);
      } else if (current.stdout !== settings.remoteUrl) {
        record(["remote", "set-url", "origin", settings.remoteUrl]);
      }
    }
    if (settings.authorName) record(["config", "user.name", settings.authorName]);
    if (settings.authorEmail) record(["config", "user.email", settings.authorEmail]);
  }

  return NextResponse.json({ settings, syncSteps });
}
