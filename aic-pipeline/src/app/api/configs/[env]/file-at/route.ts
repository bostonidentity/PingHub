import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import { readFileAtSha, repoRelativePath } from "@/lib/git-history";
import { targetHasGit } from "@/lib/git-settings";

/**
 * GET /api/configs/[env]/file-at?path=<configDir-relative>&sha=<commit>
 *
 * Returns the file content as it existed at the given commit. `exists: false`
 * when the path was not part of the tree at that commit (file added later or
 * deleted by then). Used by the Browse-tab Versions dropdown when the user
 * picks a historical version.
 */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ env: string }> },
) {
    const { env } = await params;
    const filePath = req.nextUrl.searchParams.get("path");
    const sha = req.nextUrl.searchParams.get("sha");
    if (!filePath) {
        return NextResponse.json({ error: "Missing path" }, { status: 400 });
    }
    if (!sha) {
        return NextResponse.json({ error: "Missing sha" }, { status: 400 });
    }
    if (!targetHasGit()) {
        return NextResponse.json(
            { error: "Env repo is not a git repository." },
            { status: 400 },
        );
    }

    const configDir = getConfigDir(env);
    if (!configDir) {
        return NextResponse.json({ error: "Environment not found" }, { status: 404 });
    }
    const resolved = path.resolve(configDir, filePath);
    if (!resolved.startsWith(configDir + path.sep) && resolved !== configDir) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const repoRelPath = repoRelativePath(resolved);
    if (!repoRelPath) {
        return NextResponse.json(
            { error: "File is outside the env-repo target directory." },
            { status: 400 },
        );
    }

    const result = readFileAtSha(sha, repoRelPath);
    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({
        sha,
        repoRelPath,
        exists: result.exists,
        content: result.content,
    });
}
