import { NextRequest } from "next/server";
import os from "os";
import path from "path";
import fs from "fs";
import { spawnFrConfig, getConfigDir, ConfigScope } from "@/lib/fr-config";
import { buildReport } from "@/lib/diff";
import type { CompareEndpoint } from "@/lib/diff-types";
import { appendOpLog } from "@/lib/op-history";
import { resolveJourneyDeps } from "@/lib/resolve-journey-deps";
import { getRealmRoots } from "@/lib/realm-paths";
import type { ScopeSelection } from "@/lib/fr-config-types";

/** Add resolved journey deps (sub-journeys + scripts) to scope selections. */
function addDepsToSelections(
  deps: ReturnType<typeof resolveJourneyDeps>,
  scopeSelections: ScopeSelection[],
  effectiveScopes: ConfigScope[],
) {
  if (deps.subJourneys.length > 0) {
    const journeySel = scopeSelections.find((s) => s.scope === "journeys");
    if (journeySel?.items) {
      for (const sub of deps.subJourneys) {
        if (!journeySel.items.includes(sub)) journeySel.items.push(sub);
      }
    }
  }
  if (deps.scriptUuids.length > 0) {
    let scriptSel = scopeSelections.find((s) => s.scope === "scripts");
    if (!scriptSel) {
      scriptSel = { scope: "scripts" as ScopeSelection["scope"], items: [] };
      scopeSelections.push(scriptSel);
    }
    if (!scriptSel.items) scriptSel.items = [];
    for (const uuid of deps.scriptUuids) {
      const configFile = uuid + ".json";
      if (!scriptSel.items.includes(configFile)) {
        scriptSel.items.push(configFile);
        const name = deps.scriptNames.get(uuid);
        if (name) scriptSel.items.push("name:" + name);
      }
    }
    if (!effectiveScopes.includes("scripts" as ConfigScope)) {
      effectiveScopes.push("scripts" as ConfigScope);
    }
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { source, target, scopes, scopeSelections, includeDeps, diffOptions, mode } = body as {
    source: CompareEndpoint;
    target: CompareEndpoint;
    scopes?: ConfigScope[];
    scopeSelections?: import("@/lib/fr-config-types").ScopeSelection[];
    includeDeps?: boolean;
    diffOptions?: { includeMetadata?: boolean; ignoreWhitespace?: boolean };
    /** "compare" (default) = traditional diff; "dry-run" = source-overwrites-target simulation with added/removed flipped for target-focused reading. */
    mode?: "compare" | "dry-run";
  };
  const diffMode: "compare" | "dry-run" = mode === "dry-run" ? "dry-run" : "compare";

  // Derive scope names from scopeSelections if provided
  const effectiveScopes: ConfigScope[] = scopeSelections
    ? scopeSelections.map((s) => s.scope as ConfigScope)
    : scopes ?? [];

  if (!source?.environment || !target?.environment) {
    return new Response("Missing source or target", { status: 400 });
  }

  const ts = Date.now();
  const sourceTempDir = source.mode === "remote"
    ? path.join(os.tmpdir(), `fr-compare-${ts}-source`)
    : null;
  const targetTempDir = target.mode === "remote"
    ? path.join(os.tmpdir(), `fr-compare-${ts}-target`)
    : null;

  if (sourceTempDir) fs.mkdirSync(sourceTempDir, { recursive: true });
  if (targetTempDir) fs.mkdirSync(targetTempDir, { recursive: true });

  const sourceConfigDir = source.mode === "local"
    ? getConfigDir(source.environment)
    : sourceTempDir!;
  const targetConfigDir = target.mode === "local"
    ? getConfigDir(target.environment)
    : targetTempDir!;

  if (!sourceConfigDir) return new Response("Source environment not found", { status: 404 });
  if (!targetConfigDir) return new Response("Target environment not found", { status: 404 });

  let abortSource: (() => void) | null = null;
  let abortTarget: (() => void) | null = null;

  const cleanup = () => {
    if (sourceTempDir && fs.existsSync(sourceTempDir)) {
      fs.rmSync(sourceTempDir, { recursive: true, force: true });
    }
    if (targetTempDir && fs.existsSync(targetTempDir)) {
      fs.rmSync(targetTempDir, { recursive: true, force: true });
    }
  };

  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();

      const enqueue = (obj: object) => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      };

      const pullSide = async (side: "source" | "target", endpoint: CompareEndpoint, tempDir: string | null) => {
        if (endpoint.mode === "local") {
          enqueue({ type: "exit", code: 0, side, ts: Date.now() });
          return;
        }

        const { stream: pullStream, abort } = spawnFrConfig({
          command: "fr-config-pull",
          environment: endpoint.environment,
          ...(scopeSelections ? { scopeSelections } : { scopes: effectiveScopes }),
          envOverrides: { CONFIG_DIR: tempDir! },
        });

        if (side === "source") abortSource = abort;
        else abortTarget = abort;

        const reader = pullStream.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              enqueue({ ...JSON.parse(line), side });
            } catch { /* skip malformed */ }
          }
        }
        if (buffer.trim()) {
          try { enqueue({ ...JSON.parse(buffer), side }); } catch { /* skip */ }
        }
      };

      let failed = false;
      try {
        // Always resolve journey dependencies so they appear in the dry-run
        // result for reference, regardless of the includeDeps toggle.
        // The includeDeps flag only controls whether deps are pushed in Step 3.
        let resolvedSubJourneys: string[] = [];
        let resolvedDeps: ReturnType<typeof resolveJourneyDeps> | null = null;
        if (scopeSelections) {
          const journeyScopes = scopeSelections.filter(
            (s) => s.scope === "journeys" && s.items && s.items.length > 0
          );
          if (journeyScopes.length > 0) {
            const resolveDir = source.mode === "local"
              ? getConfigDir(source.environment)
              : null;

            if (resolveDir) {
              resolvedDeps = resolveJourneyDeps(resolveDir, journeyScopes.flatMap((s) => s.items!));
              resolvedSubJourneys = resolvedDeps.subJourneys;
              addDepsToSelections(resolvedDeps, scopeSelections, effectiveScopes);
            }
          }
        }

        // If source is remote and we couldn't resolve deps yet, pull source
        // first, resolve deps, then pull target with the expanded selections.
        if (source.mode === "remote" && resolvedDeps === null && scopeSelections) {
          await pullSide("source", source, sourceTempDir);
          const journeyScopes = scopeSelections.filter(
            (s) => s.scope === "journeys" && s.items && s.items.length > 0
          );
          if (journeyScopes.length > 0) {
            resolvedDeps = resolveJourneyDeps(sourceConfigDir, journeyScopes.flatMap((s) => s.items!));
            resolvedSubJourneys = resolvedDeps.subJourneys;
            addDepsToSelections(resolvedDeps, scopeSelections, effectiveScopes);
          }
          await pullSide("target", target, targetTempDir);
        } else {
          await Promise.all([
            pullSide("source", source, sourceTempDir),
            pullSide("target", target, targetTempDir),
          ]);
        }

        // Always include the explicitly selected journeys + resolved sub-journeys
        // in the journey tree, even when nothing changed (e.g. after a successful verify).
        const forceIncludeJourneys = new Set<string>();
        if (scopeSelections) {
          for (const sel of scopeSelections) {
            if (sel.scope === "journeys" && sel.items) {
              for (const name of sel.items) forceIncludeJourneys.add(name);
            }
          }
        }

        const report = buildReport(source, sourceConfigDir, target, targetConfigDir, effectiveScopes, diffOptions, forceIncludeJourneys);

        // When scopeSelections has item-level filters, narrow the diff to only matching files
        if (scopeSelections?.some((s) => s.items && s.items.length > 0)) {
          const itemPatterns: RegExp[] = [];
          for (const sel of scopeSelections) {
            if (!sel.items || sel.items.length === 0) continue; // all items — no filter
            const isJourney = sel.scope === "journeys";
            for (let item of sel.items) {
              // Strip name: prefix used for script content files
              if (item.startsWith("name:")) item = item.slice(5);
              const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              if (isJourney) {
                // Match the journey directory (tree JSON + nodes)
                itemPatterns.push(new RegExp(`(^|/)journeys/${escaped}/`, "i"));
              } else {
                // Match file paths containing the item name (directory name or filename stem)
                itemPatterns.push(new RegExp(`(^|/)${escaped}(/|\\.|$)`, "i"));
              }
            }
          }
          if (itemPatterns.length > 0) {
            report.files = report.files.filter(
              (f) => itemPatterns.some((p) => p.test(f.relativePath))
            );
            // Recalculate summary
            report.summary = { added: 0, removed: 0, modified: 0, unchanged: 0 };
            for (const f of report.files) report.summary[f.status]++;
          }

          // Filter journey tree: always include selected journeys AND their
          // resolved sub-journeys so the tree shows the full dependency chain.
          const journeySelection = scopeSelections.find(
            (s) => s.scope === "journeys" && s.items && s.items.length > 0
          );
          if (journeySelection && report.journeyTree) {
            const selectedNames = new Set(journeySelection.items!.map((n) => n.toLowerCase()));
            // Always include resolved sub-journeys in the tree
            for (const sub of resolvedSubJourneys) {
              selectedNames.add(sub.toLowerCase());
            }
            // Filter only the top-level entries — keep full sub-journey hierarchy
            // intact so users can browse every level of inner journeys.
            report.journeyTree = report.journeyTree.filter(
              (node) => selectedNames.has(node.name.toLowerCase()),
            );
          }
        }

        // Check which resolved dependency items are missing on the target.
        // Since deps were always pulled (added to scopeSelections above),
        // items that don't exist on the target will have no files in targetConfigDir.
        //
        // Only surface this as a warning when includeDeps is off: with
        // includeDeps on, the missing items will be staged and pushed as
        // part of the promote (see promote-items route), so the warning
        // has nothing left to ask the user to do.
        if (!includeDeps && resolvedDeps && (resolvedDeps.subJourneys.length > 0 || resolvedDeps.scriptUuids.length > 0)) {
          const targetJourneyNames = new Set<string>();
          const targetScriptNames = new Set<string>();

          for (const realmRoot of getRealmRoots(targetConfigDir, "journeys")) {
            const jDir = path.join(realmRoot, "journeys");
            for (const d of fs.readdirSync(jDir, { withFileTypes: true })) {
              if (d.isDirectory()) targetJourneyNames.add(d.name);
            }
          }
          for (const realmRoot of getRealmRoots(targetConfigDir, "scripts/scripts-config")) {
            const sDir = path.join(realmRoot, "scripts", "scripts-config");
            for (const f of fs.readdirSync(sDir)) {
              if (!f.endsWith(".json")) continue;
              try {
                const json = JSON.parse(fs.readFileSync(path.join(sDir, f), "utf-8"));
                if (json.name) targetScriptNames.add(json.name);
              } catch { /* skip */ }
            }
          }

          const missingJourneys = resolvedDeps.subJourneys.filter(
            (name) => !targetJourneyNames.has(name),
          );
          const missingScripts = resolvedDeps.scriptUuids
            .map((uuid) => resolvedDeps!.scriptNames.get(uuid) ?? uuid)
            .filter((name) => !targetScriptNames.has(name));

          if (missingJourneys.length > 0 || missingScripts.length > 0) {
            report.missingDeps = { missingJourneys, missingScripts };
          }
        }

        // Strip journey tree if journeys aren't in the selected scopes
        if (scopeSelections && !effectiveScopes.includes("journeys" as ConfigScope)) {
          report.journeyTree = undefined;
        }

        // Dry-run only: flip added ↔ removed semantics for promote intuition:
        // "added" now means "will be added to target" (file exists on source only)
        // "removed" now means "will be removed from target" (file exists on target only)
        // Also flip diffLines, swap line counts, and swap localContent/remoteContent.
        // Compare mode leaves the report in traditional `diff source target` polarity.
        if (diffMode === "dry-run") {
        for (const f of report.files) {
          if (f.status === "added") {
            f.status = "removed";
          } else if (f.status === "removed") {
            f.status = "added";
          }
          if (f.status === "modified" || f.status === "added" || f.status === "removed") {
            // Swap line counts
            const la = f.linesAdded ?? 0;
            const lr = f.linesRemoved ?? 0;
            f.linesAdded = lr;
            f.linesRemoved = la;
            // Swap content fields
            const lc = f.localContent;
            f.localContent = f.remoteContent;
            f.remoteContent = lc;
            // Flip diff line types
            if (f.diffLines) {
              f.diffLines = f.diffLines.map((dl) =>
                dl.type === "added"   ? { ...dl, type: "removed" as const } :
                dl.type === "removed" ? { ...dl, type: "added" as const } :
                dl
              );
            }
          }
        }
        // Swap summary counts
        const sumAdded = report.summary.added;
        report.summary.added = report.summary.removed;
        report.summary.removed = sumAdded;

        // Also flip journey tree node statuses
        if (report.journeyTree) {
          const flipStatus = (s: "added" | "removed" | "modified" | "unchanged") =>
            s === "added" ? "removed" as const :
            s === "removed" ? "added" as const :
            s;
          const flipTree = (nodes: import("@/lib/diff-types").JourneyTreeNode[]): import("@/lib/diff-types").JourneyTreeNode[] =>
            nodes.map((n) => ({
              ...n,
              status: flipStatus(n.status),
              scripts: n.scripts.map((sc) => ({ ...sc, status: flipStatus(sc.status) })),
              nodes: n.nodes.map((nd) => ({ ...nd, status: flipStatus(nd.status) })),
              subJourneys: flipTree(n.subJourneys),
            }));
          report.journeyTree = flipTree(report.journeyTree);
        }
        } // end of dry-run flip block

        enqueue({ type: "report", data: JSON.stringify(report), ts: Date.now() });
        enqueue({ type: "exit", code: 0, ts: Date.now() });

        // Record compare op-log entry (summary only — detail is too heavy to persist)
        try {
          const { summary } = report;
          const summaryText = `${summary.added} added, ${summary.removed} removed, ${summary.modified} modified across ${report.files.length} files`;
          const scopeList = effectiveScopes;
          appendOpLog({
            type: diffMode === "dry-run" ? "dry-run" : "compare",
            environment: `${source.environment} → ${target.environment}`,
            source,
            target,
            scopes: scopeList.length ? scopeList : ["all"],
            status: "success",
            startedAt,
            durationMs: Date.now() - startTime,
            summary: summaryText,
          });
        } catch {
          // ignore
        }
      } catch {
        failed = true;
        try {
          appendOpLog({
            type: diffMode === "dry-run" ? "dry-run" : "compare",
            environment: `${source.environment} → ${target.environment}`,
            source,
            target,
            scopes: scopes ?? ["all"],
            status: "failed",
            startedAt,
            durationMs: Date.now() - startTime,
            summary: diffMode === "dry-run" ? "Dry run failed" : "Compare failed",
          });
        } catch {
          // ignore
        }
      } finally {
        cleanup();
        if (failed) {
          enqueue({ type: "exit", code: 1, ts: Date.now() });
        }
        controller.close();
      }
    },
    cancel() {
      abortSource?.();
      abortTarget?.();
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
