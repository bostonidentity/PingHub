import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { existsSync } from "fs";
import { getConfigDir } from "@/lib/fr-config";
import { listFileCommits, repoRelativePath } from "@/lib/git-history";
import { targetHasGit } from "@/lib/git-settings";

/**
 * GET /api/configs/[env]/file-history?path=<configDir-relative>&limit=50
 *
 * Returns the list of commits in the env-repo that touched this file
 * (newest first, --follow across renames). Used by the Browse-tab Versions
 * dropdown.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }
  const limitStr = req.nextUrl.searchParams.get("limit");
  const limit = limitStr ? Math.min(Math.max(Number(limitStr), 1), 500) : 50;

  if (!targetHasGit()) {
    return NextResponse.json({ gitAvailable: false, entries: [] });
  }

  const configDir = getConfigDir(env);
  if (!configDir) {
    return NextResponse.json({ error: "Environment not found" }, { status: 404 });
  }

  // Prevent directory traversal, mirror /file route semantics.
  const resolved = path.resolve(configDir, filePath);
  if (!resolved.startsWith(configDir + path.sep) && resolved !== configDir) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const repoRelPath = repoRelativePath(resolved);
  if (!repoRelPath) {
    // File exists outside the env-repo target dir (target was reconfigured?)
    return NextResponse.json({
      gitAvailable: true,
      entries: [],
      error: "File is outside the env-repo target directory.",
    });
  }

  const result = listFileCommits(repoRelPath, limit);
  if (!result.ok) {
    return NextResponse.json(
      { gitAvailable: true, entries: [], error: result.error },
      { status: 500 },
    );
  }
  // Tell the client whether the working-tree file currently exists so it can
  // present "Working tree (current)" as the default selection.
  return NextResponse.json({
    gitAvailable: true,
    repoRelPath,
    workingTreeExists: existsSync(resolved),
    entries: result.entries,
  });
}
