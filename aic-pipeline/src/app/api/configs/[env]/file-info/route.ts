import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getConfigDir } from "@/lib/fr-config";
import { loadSettings, resolveTargetDir, targetHasGit, runGit } from "@/lib/git-settings";

interface LastCommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  timestamp: number; // ms
  subject: string;
}

const SEP = "\x1f";

export async function GET(req: NextRequest, { params }: { params: Promise<{ env: string }> }) {
  const { env: environment } = await params;
  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path");

  if (!environment || !relPath) {
    return NextResponse.json({ error: "Missing environment or path" }, { status: 400 });
  }

  const configDir = getConfigDir(environment);
  if (!configDir) {
    return NextResponse.json({ error: "Config dir not found" }, { status: 404 });
  }

  const settings = loadSettings();
  if (!targetHasGit(settings)) {
    return NextResponse.json({ lastCommit: null, reason: "target is not a git repo" });
  }
  const targetDir = resolveTargetDir(settings);

  // Resolve and validate: the file must live under configDir (and thus under targetDir).
  const absPath = path.resolve(configDir, relPath);
  const configReal = fs.realpathSync.native(configDir);
  const absReal = fs.existsSync(absPath) ? fs.realpathSync.native(absPath) : absPath;
  if (!absReal.startsWith(configReal + path.sep) && absReal !== configReal) {
    return NextResponse.json({ error: "Path escapes config dir" }, { status: 400 });
  }
  if (!fs.existsSync(absPath)) {
    return NextResponse.json({ lastCommit: null });
  }

  const pathInRepo = path.relative(targetDir, absPath);
  const format = ["%H", "%h", "%an", "%ae", "%at", "%s"].join(SEP);
  const res = runGit(
    ["log", "-n", "1", `--pretty=format:${format}`, "--", pathInRepo],
    targetDir,
  );

  if (!res.ok || !res.stdout.trim()) {
    return NextResponse.json({ lastCommit: null });
  }

  const [hash, shortHash, authorName, authorEmail, timestamp, subject] = res.stdout.split(SEP);
  const lastCommit: LastCommitInfo = {
    hash,
    shortHash,
    authorName,
    authorEmail,
    timestamp: Number(timestamp) * 1000,
    subject,
  };
  return NextResponse.json({ lastCommit });
}
