import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { loadSettings, resolveTargetDir, runGit, targetHasGit } from "@/lib/git-settings";

/**
 * Lists the immediate subfolders of the env target dir (each one treated as
 * an "environment" — e.g. ide/, ide3/, prod/, sit/, uat/) plus a virtual
 * "Root files" entry covering loose files like environments.json. Used by
 * the Repo page's Push scope selector.
 *
 * For each entry we also report whether it currently has uncommitted changes,
 * so the chips can show a dirty indicator and gray out clean ones.
 */
const SKIP_DIRS = new Set([".git", "node_modules"]);

export async function GET() {
    const settings = loadSettings();
    const cwd = resolveTargetDir(settings);
    if (!fs.existsSync(cwd)) {
        return NextResponse.json({ ok: false, error: `Target dir not found: ${cwd}` }, { status: 400 });
    }

    // Gather all top-level entries.
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(cwd, { withFileTypes: true });
    } catch (e) {
        return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }

    const folders = entries
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
        .map((e) => e.name)
        .sort();
    const hasRootFiles = entries.some(
        (e) => e.isFile() && !e.name.startsWith(".") && !e.name.endsWith(".lock"),
    );

    // Per-folder dirty count (only meaningful if the repo is initialised).
    const dirtyByFolder = new Map<string, number>();
    let rootDirty = 0;
    if (targetHasGit(settings)) {
        const res = runGit(["status", "--porcelain"], cwd);
        if (res.ok) {
            for (const raw of res.stdout.split("\n")) {
                const line = raw.trimEnd();
                if (!line) continue;
                // Porcelain v1: "XY path" (XY is 2 chars + space). Path may be "old -> new".
                const filePath = line.slice(3).split(" -> ").pop()!.trim();
                const top = filePath.split("/")[0];
                if (folders.includes(top)) {
                    dirtyByFolder.set(top, (dirtyByFolder.get(top) ?? 0) + 1);
                } else if (!filePath.includes("/")) {
                    rootDirty++;
                }
            }
        }
    }

    return NextResponse.json({
        ok: true,
        targetDir: cwd,
        envs: folders.map((name) => ({
            name,
            path: name,
            dirtyCount: dirtyByFolder.get(name) ?? 0,
            isFolder: true,
        })),
        rootFiles: hasRootFiles
            ? { name: "Root files", path: ".", dirtyCount: rootDirty, isFolder: false }
            : null,
    });
}
