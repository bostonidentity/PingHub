import { NextRequest, NextResponse } from "next/server";
import { loadSettings, resolveTargetDir, targetHasGit, runGit } from "@/lib/git-settings";

const SEP = "\x1f";
const REC = "\x1e";

export async function GET(req: NextRequest) {
  const settings = loadSettings();
  if (!targetHasGit(settings)) {
    return NextResponse.json({ ok: false, error: "Target is not a git repo." }, { status: 400 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
  const skip = Math.max(Number(url.searchParams.get("skip") ?? 0), 0);

  const format = ["%H", "%h", "%an", "%ae", "%at", "%s"].join(SEP) + REC;
  const res = runGit(
    ["log", `--pretty=format:${format}`, `-n`, String(limit), `--skip=${skip}`],
    resolveTargetDir(settings),
  );

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.stderr || "git log failed" }, { status: 500 });
  }

  const commits = res.stdout
    .split(REC)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, authorName, authorEmail, timestamp, subject] = line.split(SEP);
      return {
        hash,
        shortHash,
        authorName,
        authorEmail,
        timestamp: Number(timestamp) * 1000,
        subject,
      };
    });

  return NextResponse.json({ ok: true, commits, hasMore: commits.length === limit });
}
