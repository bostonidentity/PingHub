/**
 * Temporary git-worktree helper for "compare at SHA" workflows.
 *
 * `git worktree add --detach <tmp> <sha>` checks out the env-repo's tree at
 * a specific commit into a side directory without touching the primary
 * working copy or the index. We use it to materialise two historical
 * snapshots side-by-side so `buildReport` (which expects two directories)
 * can run unmodified for Browse → Compare on journeys / IGA workflows.
 *
 * Worktrees are tracked in `.git/worktrees/`. We `git worktree remove --force`
 * on cleanup and additionally `git worktree prune` as a belt-and-braces step
 * in case the temp dir was already gone.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { resolveTargetDir, runGit, targetHasGit } from "@/lib/git-settings";

export interface WorktreeHandle {
    /** Absolute path to the materialised tree (the repo root inside the worktree). */
    path: string;
    /** Release the worktree. Safe to call multiple times. */
    cleanup: () => void;
}

/**
 * Create a detached worktree at `sha`. Returns the absolute path of the
 * worktree root plus a `cleanup` that removes it.
 *
 * Throws when git isn't available or `worktree add` fails.
 */
export function createWorktreeAtSha(sha: string): WorktreeHandle {
    if (!targetHasGit()) throw new Error("Env repo is not a git repository.");
    if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) throw new Error("Invalid commit sha.");

    const repoRoot = resolveTargetDir();
    const tmpRoot = path.join(
        os.tmpdir(),
        `pinghub-wt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    );

    const res = runGit(["worktree", "add", "--detach", "--quiet", tmpRoot, sha], repoRoot);
    if (!res.ok) {
        // Best-effort cleanup if `add` half-succeeded.
        try { runGit(["worktree", "remove", "--force", tmpRoot], repoRoot); } catch { /* ignore */ }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error(res.stderr || `git worktree add failed (sha=${sha})`);
    }

    let released = false;
    const cleanup = () => {
        if (released) return;
        released = true;
        // `git worktree remove` first so git's bookkeeping is clean, then
        // rmSync to mop up any leftover files. `prune` finishes the job if
        // the directory disappears mid-flight (e.g. AV scanner / EBUSY).
        try { runGit(["worktree", "remove", "--force", tmpRoot], repoRoot); } catch { /* ignore */ }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        try { runGit(["worktree", "prune"], repoRoot); } catch { /* ignore */ }
    };

    return { path: tmpRoot, cleanup };
}

/**
 * Validate a "slot" string from API input — either the literal token
 * `"working"` (use the live working tree) or a hex commit sha.
 */
export function isValidSlot(slot: string): boolean {
    return slot === "working" || /^[0-9a-fA-F]{4,64}$/.test(slot);
}
