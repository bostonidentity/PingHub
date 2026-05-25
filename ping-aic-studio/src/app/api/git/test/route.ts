import { NextRequest, NextResponse } from "next/server";
import { loadSettings, runGit } from "@/lib/git-settings";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const remoteUrl = (body.remoteUrl as string | undefined) ?? loadSettings().remoteUrl;

  if (!remoteUrl) {
    return NextResponse.json({ ok: false, error: "No remote URL configured." }, { status: 400 });
  }

  const res = runGit(["ls-remote", "--heads", remoteUrl], process.cwd(), 15_000);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.stderr || "Connection failed." });
  }

  const branches = res.stdout
    .split("\n")
    .map((line) => line.split(/\s+/)[1]?.replace("refs/heads/", ""))
    .filter(Boolean);

  return NextResponse.json({ ok: true, branches });
}
