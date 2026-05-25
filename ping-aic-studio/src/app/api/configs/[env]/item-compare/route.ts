import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getConfigDir } from "@/lib/fr-config";
import { resolveTargetDir, targetHasGit } from "@/lib/git-settings";
import { createWorktreeAtSha, isValidSlot } from "@/lib/git-worktree";
import { buildReport } from "@/lib/diff";
import type { CompareEndpoint, CompareReport, FileDiff } from "@/lib/diff-types";
import type { ConfigScope } from "@/lib/fr-config-types";

/**
 * POST /api/configs/[env]/item-compare
 *
 * Body: { scope: string, item: string, shaA: "working"|<sha>, shaB: "working"|<sha> }
 *
 * Materialises the env-repo at each requested SHA (working tree is used as
 * is) into temporary worktrees and runs `buildReport` filtered to the
 * requested scope/item, then returns the resulting `CompareReport` trimmed
 * to files relevant to that item.
 *
 * Used by the Browse → Compare flow for journeys and IGA workflows so the
 * existing `JourneyDiffGraphModal` / `WorkflowDiffGraphModal` (which both
 * expect a `CompareReport`-shaped input) can render dependency-pinned diffs
 * between two historical versions without re-implementing the engine.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ env: string }> },
) {
    const { env } = await params;
    const body = (await req.json().catch(() => null)) as
        | { scope?: string; item?: string; shaA?: string; shaB?: string }
        | null;
    if (!body?.scope || !body.item || !body.shaA || !body.shaB) {
        return NextResponse.json(
            { error: "Missing scope, item, shaA, or shaB" },
            { status: 400 },
        );
    }
    const { scope, item, shaA, shaB } = body;

    if (!isValidSlot(shaA) || !isValidSlot(shaB)) {
        return NextResponse.json({ error: "Invalid sha (must be 'working' or hex)" }, { status: 400 });
    }
    if (shaA === "working" && shaB === "working") {
        return NextResponse.json(
            { error: "Both slots cannot be 'working' — pick at least one historical version." },
            { status: 400 },
        );
    }

    if (!targetHasGit()) {
        return NextResponse.json({ error: "Env repo is not a git repository." }, { status: 400 });
    }

    const realConfigDir = getConfigDir(env);
    if (!realConfigDir) {
        return NextResponse.json({ error: "Environment not found" }, { status: 404 });
    }
    const repoRoot = resolveTargetDir();
    const relConfigDir = path.relative(repoRoot, realConfigDir);

    /**
     * Resolve a slot to the configDir path that should be passed to
     * `buildReport`. Returns the cleanup callback created by
     * `createWorktreeAtSha`, if any — caller invokes it after buildReport.
     */
    function resolveSlot(slot: string): { dir: string; cleanup?: () => void } {
        if (slot === "working") return { dir: realConfigDir! };
        const wt = createWorktreeAtSha(slot);
        return { dir: path.join(wt.path, relConfigDir), cleanup: wt.cleanup };
    }

    let slotA: { dir: string; cleanup?: () => void } | null = null;
    let slotB: { dir: string; cleanup?: () => void } | null = null;
    try {
        slotA = resolveSlot(shaA);
        slotB = resolveSlot(shaB);

        // A = old (source / "left"), B = new (target / "right"). Matches the
        // Compare-page convention where the left environment is "source" and
        // diff entries with status "added" mean the file exists in target but
        // not source.
        const sourceEndpoint: CompareEndpoint = { environment: `${env}@${shaA.slice(0, 8)}`, mode: "local" };
        const targetEndpoint: CompareEndpoint = { environment: `${env}@${shaB.slice(0, 8)}`, mode: "local" };

        // For journeys, force-include the selected journey so its full tree
        // (including sub-journeys and referenced scripts) is built even when
        // those files happen to be unchanged.
        const forceIncludeJourneys =
            scope === "journeys" ? new Set<string>([item]) : undefined;

        const report: CompareReport = buildReport(
            sourceEndpoint,
            slotA.dir,
            targetEndpoint,
            slotB.dir,
            [scope as ConfigScope],
            { includeMetadata: false, ignoreWhitespace: true },
            forceIncludeJourneys,
        );

        // Trim files to only those relevant to the requested item. Keep
        // scripts referenced by a journey (their content paths contain the
        // script name not the journey name, so we lean on `journeyTree` for
        // dependency context and keep ALL files when the engine pulled
        // dependencies in via forceIncludeJourneys). This keeps the payload
        // small for single-item scopes (workflows live entirely under
        // `iga/workflows/<item>/`).
        let files: FileDiff[] = report.files;
        if (scope === "iga-workflows") {
            files = files.filter((f) => f.relativePath.includes(`iga/workflows/${item}/`));
        } else if (scope === "journeys") {
            // Keep journey files for this item AND any script files (engine
            // includes them because of forceIncludeJourneys). Sub-journeys
            // and their nodes are also kept so the modal can render them.
            files = files.filter((f) => {
                const rp = f.relativePath;
                if (rp.includes(`/journeys/${item}/`) || rp.endsWith(`/journeys/${item}.json`)) return true;
                // Scripts referenced via forceIncludeJourneys → keep all
                // script files; the engine wouldn't have included them
                // otherwise.
                if (/\/scripts\/(scripts-config|scripts-content)\//.test(rp)) return true;
                // Sub-journeys pulled in by dep resolution — keep their tree.
                if (/\/journeys\/[^/]+\//.test(rp)) return true;
                return false;
            });
        }

        return NextResponse.json({
            ...report,
            files,
        });
    } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    } finally {
        slotA?.cleanup?.();
        slotB?.cleanup?.();
    }
}
