import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import { findRealmContaining } from "@/lib/realm-paths";
import { listMultiPathCommits, repoRelativePath } from "@/lib/git-history";
import { targetHasGit } from "@/lib/git-settings";

/**
 * GET /api/configs/[env]/item-history?scope=&item=&limit=50
 *
 * Returns commits in the env-repo that touched any file belonging to this
 * item. Used by the Browse → Compare flow for multi-file items (journeys,
 * IGA workflows) where the "file" the user is looking at is actually a
 * directory of related files.
 *
 * Resolution per scope:
 *   - journeys      → `<realm_root>/journeys/<item>/`
 *   - iga-workflows → `<configDir>/iga/workflows/<item>/`
 *
 * For other scopes the per-file history endpoint is sufficient.
 */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ env: string }> },
) {
    const { env } = await params;
    const scope = req.nextUrl.searchParams.get("scope");
    const item = req.nextUrl.searchParams.get("item");
    if (!scope || !item) {
        return NextResponse.json({ error: "Missing scope or item" }, { status: 400 });
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

    // Resolve the item's directory(ies) on the working tree. If the item dir
    // no longer exists (file was deleted) we can't compute history here —
    // the caller should fall back to the per-file endpoint with a known
    // historic path.
    const itemDirs: string[] = [];
    if (scope === "journeys") {
        const realmRoot = findRealmContaining(configDir, path.join("journeys", item));
        if (realmRoot) itemDirs.push(path.join(realmRoot, "journeys", item));
    } else if (scope === "iga-workflows") {
        const wfDir = path.join(configDir, "iga", "workflows", item);
        if (fs.existsSync(wfDir)) itemDirs.push(wfDir);
    } else {
        return NextResponse.json(
            { error: `Scope ${scope} doesn't use item-level history. Use /file-history instead.` },
            { status: 400 },
        );
    }

    if (itemDirs.length === 0) {
        return NextResponse.json({
            gitAvailable: true,
            entries: [],
            error: "Item directory not found in working tree.",
        });
    }

    // Validate each dir is inside the configDir and resolve to a repo-rel path.
    const repoRelPaths: string[] = [];
    for (const dir of itemDirs) {
        if (!dir.startsWith(configDir + path.sep) && dir !== configDir) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        const rel = repoRelativePath(dir);
        if (rel) repoRelPaths.push(rel);
    }

    if (repoRelPaths.length === 0) {
        return NextResponse.json({
            gitAvailable: true,
            entries: [],
            error: "Item is outside the env-repo target directory.",
        });
    }

    const result = listMultiPathCommits(repoRelPaths, limit);
    if (!result.ok) {
        return NextResponse.json(
            { gitAvailable: true, entries: [], error: result.error },
            { status: 500 },
        );
    }
    return NextResponse.json({
        gitAvailable: true,
        repoRelPaths,
        entries: result.entries,
    });
}
