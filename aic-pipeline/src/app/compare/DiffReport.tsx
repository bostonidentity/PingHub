"use client";

import { useState, useMemo, useRef, useCallback, useEffect, createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import { DiffMinimap } from "./DiffMinimap";
import type { CompareReport, FileDiff, DiffLine, JourneyTreeNode, JourneyScript, JourneyNodeInfo } from "@/lib/diff-types";
import { cn } from "@/lib/utils";
import { js_beautify } from "js-beautify";
import { JourneyDiffGraphModal, type NavEntry } from "./JourneyDiffGraph";
import { WorkflowDiffGraphModal } from "./WorkflowDiffGraph";
import type { PromotionTask } from "@/lib/promotion-tasks";
import type { ScopeSelection, ConfigScope } from "@/lib/fr-config-types";
import { useDialog } from "@/components/ConfirmDialog";
import { formatScopeLabel } from "@/lib/compare";
import { FileContentViewer } from "@/components/FileContentViewer";
import { EsvDisplayToggle } from "@/components/EsvDisplayToggle";
import { pathToScopeItem } from "@/lib/scope-paths";
import { useEsvDisplayMode, isEsvPath, decodeEsvContent } from "@/lib/esv-decode";

// ── Client-side content formatting ───────────────────────────────────────────

function formatContent(content: string, filePath: string): string {
  // JSON files — pretty-print (server may have already done this, but handles edge cases)
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { /* not JSON */ }
  // JS / Groovy scripts — use js-beautify
  if (/\.(js|groovy)$/i.test(filePath)) {
    return js_beautify(content, { indent_size: 2, end_with_newline: true });
  }
  return content;
}

// ── Client-side LCS diff (mirrors server diff.ts logic) ──────────────────────

function clientDiff(aText: string, bText: string): DiffLine[] {
  const a = aText === "" ? [] : aText.split("\n");
  const b = bText === "" ? [] : bText.split("\n");
  const m = a.length, n = b.length;
  // Bail on very large files to avoid freezing the browser
  if (m > 2000 || n > 2000) return [{ type: "context", content: "(file too large to diff in browser)" }];
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const lines: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { lines.unshift({ type: "context", content: a[i-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { lines.unshift({ type: "added", content: b[j-1] }); j--; }
    else { lines.unshift({ type: "removed", content: a[i-1] }); i--; }
  }
  return lines;
}

// ── Syntax highlight ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Task integration helpers ──────────────────────────────────────────────────

const FILE_SELECTABLE_PATH_SCOPES = new Set(["scripts", "custom-nodes", "endpoints", "schedules"]);
const NAME_FLAG_PATH_SCOPES = new Set(["journeys", "managed-objects", "iga-workflows"]);
// DIR-based scopes whose backend pushers accept a `name` filter (templateName /
// mappingName). Paths look like `email-templates/<template>/…` or
// `sync/mappings/<mapping>/…` — the first path segment after the scope dir
// identifies the item.
const DIR_BASED_PATH_SCOPES = new Set(["email-templates", "connector-mappings"]);

/** True when the given relative path belongs to the task's items array. */
function fileInTask(relativePath: string, task: PromotionTask): boolean {
  const { scope, itemId } = pathToTaskScopeAndItem(relativePath);
  const sel = task.items.find((s) => s.scope === scope);
  if (!sel) return false;
  if (sel.items === undefined) return true; // whole scope selected
  return itemId != null && sel.items.includes(itemId);
}

/** Remove an item (identified by its relativePath) from a task's items list,
 *  returning the new items array. Whole-scope selections are removed entirely
 *  only when the caller passes a path that resolves to `itemId === null`; for
 *  individual-item paths, whole-scope selections are left untouched. */
function removeItemFromTaskItems(
  relativePath: string,
  items: ScopeSelection[],
): ScopeSelection[] {
  const { scope, itemId } = pathToTaskScopeAndItem(relativePath);
  return items.flatMap<ScopeSelection>((s) => {
    if (s.scope !== scope) return [s];
    if (s.items === undefined) {
      return itemId === null ? [] : [s];
    }
    const filtered = s.items.filter((i) => i !== itemId);
    return filtered.length ? [{ ...s, items: filtered }] : [];
  });
}

/** Map a relativePath from the diff to a { scope, itemId } for promotion task merge.
 *  itemId === null means the whole scope (no item-level selection). */
function pathToTaskScopeAndItem(relativePath: string): { scope: string; itemId: string | null } {
  const parts = relativePath.split("/");
  const scope = extractScope(relativePath);

  if (NAME_FLAG_PATH_SCOPES.has(scope)) {
    const scopeIdx = parts.findIndex((p) => p === scope);
    const itemId = scopeIdx >= 0 && parts.length > scopeIdx + 1 ? parts[scopeIdx + 1] : null;
    return { scope, itemId };
  }
  if (FILE_SELECTABLE_PATH_SCOPES.has(scope)) {
    if (relativePath.includes("scripts-content/")) {
      // Script content file: scripts-content/{type}/{ScriptName}.ext
      // Use the filename (without extension) prefixed with "name:" so promote-items can resolve it
      const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "");
      return { scope, itemId: `name:${fileName}` };
    }

    // Scripts are realm-based (realms/<realm>/scripts/scripts-config/<uuid>.json).
    // The item ID is the filename (UUID), matching what scriptItems() returns in the audit API.
    if (scope === "scripts") return { scope, itemId: parts[parts.length - 1] };

    // All other FILE_SELECTABLE scopes (endpoints, schedules, custom-nodes) store items as
    // directories. The audit API lists those directory names as item IDs.
    // Path: <scope>/<item>/...  →  item = parts[1]
    // custom-nodes has an extra nodes/ level: custom-nodes/nodes/<item>/...  →  item = parts[2]
    const scopeIdx = parts.indexOf(scope);
    let itemIdx = scopeIdx + 1;
    if (scope === "custom-nodes" && parts[itemIdx] === "nodes") itemIdx++;
    return { scope, itemId: parts[itemIdx] ?? null };
  }
  if (DIR_BASED_PATH_SCOPES.has(scope)) {
    // Derive the per-item directory name via the shared scope-path parser.
    // `email-templates/welcome/welcome.md` → "welcome".
    // `sync/mappings/systemAd_managedUser/...` → "systemAd_managedUser".
    const parsed = pathToScopeItem(relativePath);
    return { scope, itemId: parsed?.item || null };
  }
  return { scope, itemId: null };
}

/** Merge selected diff paths into the existing task items. */
function mergePathsIntoItems(
  selectedPaths: Set<string>,
  existingItems: ScopeSelection[],
): ScopeSelection[] {
  const scopeMap = new Map<string, Set<string> | null>();
  for (const path of selectedPaths) {
    const { scope, itemId } = pathToTaskScopeAndItem(path);
    if (!scopeMap.has(scope)) {
      scopeMap.set(scope, itemId === null ? null : new Set([itemId]));
    } else {
      const cur = scopeMap.get(scope);
      if (cur == null || itemId === null) scopeMap.set(scope, null);
      else cur.add(itemId);
    }
  }
  const result: ScopeSelection[] = [...existingItems];
  for (const [scope, itemIds] of scopeMap) {
    const idx = result.findIndex((s) => s.scope === scope);
    if (itemIds === null) {
      if (idx >= 0) result[idx] = { scope: scope as ConfigScope, items: undefined };
      else result.push({ scope: scope as ConfigScope });
    } else {
      const newIds = [...itemIds];
      if (idx >= 0) {
        const prev = result[idx].items;
        result[idx] = { scope: scope as ConfigScope, items: prev === undefined ? undefined : [...new Set([...prev, ...newIds])] };
      } else {
        result.push({ scope: scope as ConfigScope, items: newIds });
      }
    }
  }
  return result;
}

function highlightLine(raw: string): string {
  return escapeHtml(raw).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let color = "#60a5fa";
      if (/^"/.test(match)) color = /:$/.test(match) ? "#94a3b8" : "#86efac";
      else if (/true|false/.test(match)) color = "#fbbf24";
      else if (/null/.test(match)) color = "#f87171";
      return `<span style="color:${color}">${match}</span>`;
    }
  );
}

// ── Context collapsing ────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;

type HunkItem = DiffLine | { type: "ellipsis"; count: number; startIdx: number };

function buildHunks(lines: DiffLine[]): HunkItem[] {
  const changed = new Set<number>();
  lines.forEach((l, i) => { if (l.type !== "context") changed.add(i); });

  const visible = new Set<number>();
  for (const idx of changed) {
    for (let j = Math.max(0, idx - CONTEXT_LINES); j <= Math.min(lines.length - 1, idx + CONTEXT_LINES); j++) {
      visible.add(j);
    }
  }

  const result: HunkItem[] = [];
  let i = 0;
  while (i < lines.length) {
    if (visible.has(i)) {
      result.push(lines[i]);
      i++;
    } else {
      const start = i;
      while (i < lines.length && !visible.has(i)) i++;
      result.push({ type: "ellipsis", count: i - start, startIdx: start });
    }
  }
  return result;
}

// ── Unified diff viewer ───────────────────────────────────────────────────────

function DiffViewer({ lines, fullscreen, wrap }: { lines: DiffLine[]; fullscreen?: boolean; wrap?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const hunks = buildHunks(lines);

  let leftNo = 0, rightNo = 0;
  const lineNums: Array<{ left: number | null; right: number | null }> = lines.map((l) => {
    if (l.type === "removed") { leftNo++; return { left: leftNo, right: null }; }
    if (l.type === "added")   { rightNo++; return { left: null, right: rightNo }; }
    leftNo++; rightNo++;
    return { left: leftNo, right: rightNo };
  });

  let lineIdx = 0;

  return (
    <div className={cn("flex bg-slate-950 overflow-hidden", fullscreen ? "flex-1 min-h-0" : "max-h-[600px]")}>
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-auto text-[11px] font-mono leading-5">
      <table className="min-w-full border-collapse">
        <tbody>
          {hunks.map((item, hi) => {
            if (item.type === "ellipsis") {
              const si = item.startIdx;
              lineIdx += item.count;
              return (
                <tr key={`e-${hi}`} className="bg-slate-900">
                  <td colSpan={4} className="py-0.5 px-3 text-center">
                    <button
                      onClick={() => setExpanded((prev) => { const s = new Set(prev); s.has(si) ? s.delete(si) : s.add(si); return s; })}
                      className="text-sky-500 hover:text-sky-300 text-[10px]"
                    >
                      {expanded.has(si)
                        ? "▲ collapse"
                        : `▼ ${item.count} unchanged line${item.count !== 1 ? "s" : ""}`}
                    </button>
                    {expanded.has(si) && lines.slice(si, si + item.count).map((l, j) => {
                      const { left, right } = lineNums[si + j];
                      return (
                        <div key={j} className="text-left flex">
                          <span className="select-none text-slate-600 text-right w-10 border-r border-slate-800 px-2">{left}</span>
                          <span className="select-none text-slate-600 text-right w-10 border-r border-slate-800 px-2">{right}</span>
                          <span className="select-none w-4 px-1 text-slate-600"> </span>
                          <span
                            className={cn("px-2 text-slate-500", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}
                            dangerouslySetInnerHTML={{ __html: highlightLine(l.content) }}
                          />
                        </div>
                      );
                    })}
                  </td>
                </tr>
              );
            }

            const l = item as DiffLine;
            const { left, right } = lineNums[lineIdx++];
            const bg = l.type === "added" ? "bg-emerald-950" : l.type === "removed" ? "bg-red-950" : "";
            const pfxColor = l.type === "added" ? "text-emerald-400" : l.type === "removed" ? "text-red-400" : "text-slate-600";
            const textColor = l.type === "added" ? "text-emerald-300" : l.type === "removed" ? "text-red-300" : "text-slate-400";
            const prefix = l.type === "added" ? "+" : l.type === "removed" ? "-" : " ";

            return (
              <tr key={`l-${hi}`} className={bg}>
                <td className="select-none text-slate-600 text-right px-2 py-0 w-10 border-r border-slate-800">{left ?? ""}</td>
                <td className="select-none text-slate-600 text-right px-2 py-0 w-10 border-r border-slate-800">{right ?? ""}</td>
                <td className={cn("px-1 py-0 select-none w-4", pfxColor)}>{prefix}</td>
                <td
                  className={cn("px-2 py-0", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre", textColor)}
                  dangerouslySetInnerHTML={{ __html: highlightLine(l.content) }}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <DiffMinimap lines={lines} scrollRef={scrollRef} />
    </div>
  );
}

// ── Side-by-side alignment ───────────────────────────────────────────────────

export type DiffMode = "compare" | "dry-run";

/** Context for the current diff interpretation. Provided at the DiffReport root. */
const DiffModeContext = createContext<DiffMode>("compare");

type AlignedRow = {
  leftContent?: string;
  rightContent?: string;
  leftNo?: number;
  rightNo?: number;
  /** "context" = same on both sides. "leftOnly" / "rightOnly" = line only on that side. "changed" = different on both sides. */
  type: "context" | "leftOnly" | "rightOnly" | "changed";
};

/**
 * Build aligned rows for side-by-side rendering.
 *
 * - `compare` (traditional `diff source target`): `removed` diff lines are
 *   source-only and render on the left; `added` diff lines are target-only
 *   and render on the right.
 * - `dry-run`: polarity already flipped by the API so `added` = source-only
 *   (will be added to target) → left side, `removed` = target-only → right
 *   side.
 *
 * Row `type` is expressed in pane-relative terms (leftOnly / rightOnly) so
 * rendering color and prefix logic depend only on the `mode`, not on which
 * underlying diff-line type happened to feed the row.
 */
function buildAlignedRows(diffLines: DiffLine[], mode: DiffMode): AlignedRow[] {
  const rows: AlignedRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let i = 0;

  while (i < diffLines.length) {
    if (diffLines[i].type === "context") {
      leftNo++; rightNo++;
      rows.push({ leftContent: diffLines[i].content, rightContent: diffLines[i].content, leftNo, rightNo, type: "context" });
      i++;
    } else {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < diffLines.length && diffLines[i].type === "removed") { removed.push(diffLines[i].content); i++; }
      while (i < diffLines.length && diffLines[i].type === "added")   { added.push(diffLines[i].content);   i++; }

      const leftCol  = mode === "dry-run" ? added   : removed;
      const rightCol = mode === "dry-run" ? removed : added;

      const len = Math.max(leftCol.length, rightCol.length);
      for (let j = 0; j < len; j++) {
        const hasL = j < leftCol.length;
        const hasR = j < rightCol.length;
        if (hasL) leftNo++;
        if (hasR) rightNo++;
        rows.push({
          leftContent:  hasL ? leftCol[j]  : undefined,
          rightContent: hasR ? rightCol[j] : undefined,
          leftNo:  hasL ? leftNo  : undefined,
          rightNo: hasR ? rightNo : undefined,
          type: hasL && hasR ? "changed" : hasL ? "leftOnly" : "rightOnly",
        });
      }
    }
  }
  return rows;
}

// ── Side-by-side file viewer ────────────────────────────────────────────────

function SideBySideViewer({
  localContent,
  remoteContent,
  diffLines,
  sourceLabel,
  targetLabel,
  fullscreen,
  wrap,
}: {
  localContent?: string;
  remoteContent?: string;
  diffLines?: DiffLine[];
  sourceLabel: string;
  targetLabel: string;
  fullscreen?: boolean;
  wrap?: boolean;
}) {
  const mode = useContext(DiffModeContext);
  // In compare mode the API leaves FileDiff.localContent = source, .remoteContent = target.
  // In dry-run mode the API swaps them, so un-swap here to keep pane ↔ content consistent.
  const sourceContent = mode === "dry-run" ? remoteContent : localContent;
  const targetContent = mode === "dry-run" ? localContent : remoteContent;
  const alignedRows = diffLines && diffLines.length > 0 ? buildAlignedRows(diffLines, mode) : null;
  const leftScrollRef  = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);

  // Sync scroll: whichever pane the user scrolls, mirror to the other
  useEffect(() => {
    const left  = leftScrollRef.current;
    const right = rightScrollRef.current;
    if (!left || !right) return;
    let syncing = false;
    function onLeft()  { if (syncing) return; syncing = true; right!.scrollTop = left!.scrollTop;  syncing = false; }
    function onRight() { if (syncing) return; syncing = true; left!.scrollTop  = right!.scrollTop; syncing = false; }
    left.addEventListener("scroll",  onLeft,  { passive: true });
    right.addEventListener("scroll", onRight, { passive: true });
    return () => { left.removeEventListener("scroll", onLeft); right.removeEventListener("scroll", onRight); };
  }, []);

  return (
    <div className={cn(
      "flex divide-x divide-slate-700 bg-slate-950 overflow-hidden",
      fullscreen ? "flex-1 min-h-0" : "h-[600px]"
    )}>
      <FilePane
        label={sourceLabel}
        content={sourceContent}
        absence={`Not in ${sourceLabel}`}
        rows={alignedRows}
        side="left"
        wrap={wrap}
        scrollRef={leftScrollRef}
        mode={mode}
      />
      <FilePane
        label={targetLabel}
        content={targetContent}
        absence={`Not in ${targetLabel}`}
        rows={alignedRows}
        side="right"
        wrap={wrap}
        scrollRef={rightScrollRef}
        mode={mode}
      />
      {diffLines && diffLines.length > 0 && (
        <DiffMinimap lines={diffLines} scrollRef={rightScrollRef} />
      )}
    </div>
  );
}

// Per-mode pane styling. Keys describe pane semantics, not diff-line types.
// compare:  left pane = source ("-" red), right pane = target ("+" green) — classic diff polarity.
// dry-run:  left pane = source ("+" green), right pane = target ("-" red) — target-overwrite focus.
type PaneStyle = {
  bg: Record<AlignedRow["type"], { left: string; right: string }>;
  text: Record<AlignedRow["type"], { left: string; right: string }>;
  prefix: { left: "+" | "-"; right: "+" | "-" };
};

const PANE_STYLES: Record<DiffMode, PaneStyle> = {
  compare: {
    bg: {
      context:   { left: "",              right: ""              },
      leftOnly:  { left: "bg-red-950",    right: "bg-slate-900"  },
      rightOnly: { left: "bg-slate-900",  right: "bg-emerald-950"},
      changed:   { left: "bg-red-950",    right: "bg-emerald-950"},
    },
    text: {
      context:   { left: "text-slate-400",  right: "text-slate-400"  },
      leftOnly:  { left: "text-red-300",    right: "text-slate-600"  },
      rightOnly: { left: "text-slate-600",  right: "text-emerald-300"},
      changed:   { left: "text-red-300",    right: "text-emerald-300"},
    },
    prefix: { left: "-", right: "+" },
  },
  "dry-run": {
    bg: {
      context:   { left: "",                right: ""                },
      leftOnly:  { left: "bg-emerald-950",  right: "bg-slate-900"    },
      rightOnly: { left: "bg-slate-900",    right: "bg-red-950"      },
      changed:   { left: "bg-emerald-950",  right: "bg-red-950"      },
    },
    text: {
      context:   { left: "text-slate-400",    right: "text-slate-400"  },
      leftOnly:  { left: "text-emerald-300",  right: "text-slate-600"  },
      rightOnly: { left: "text-slate-600",    right: "text-red-300"    },
      changed:   { left: "text-emerald-300",  right: "text-red-300"    },
    },
    prefix: { left: "+", right: "-" },
  },
};

function FilePane({
  label, content, absence, rows, side, wrap, scrollRef, mode,
}: {
  label: string;
  content?: string;
  absence: string;
  rows?: AlignedRow[] | null;
  side: "left" | "right";
  wrap?: boolean;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  mode: DiffMode;
}) {
  const style = PANE_STYLES[mode];
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="px-3 py-1.5 bg-slate-800 border-b border-slate-700 shrink-0">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
      </div>
      {rows ? (
        /* Aligned diff view */
        <div ref={scrollRef} className="flex-1 overflow-auto text-[11px] font-mono leading-5 min-h-0">
          <table className="min-w-full border-collapse">
            <tbody>
              {rows.map((row, i) => {
                const lineNo   = side === "left" ? row.leftNo  : row.rightNo;
                const lineText = side === "left" ? row.leftContent : row.rightContent;
                const bg   = style.bg[row.type][side];
                const text = style.text[row.type][side];
                const hasContent = side === "left" ? row.leftContent !== undefined : row.rightContent !== undefined;
                const prefix = row.type === "context" ? " "
                  : hasContent ? style.prefix[side]
                  : " ";
                const pfxColor = prefix === "-" ? "text-red-500" : prefix === "+" ? "text-emerald-400" : "text-slate-600";
                return (
                  <tr key={i} className={bg}>
                    <td className="select-none text-slate-600 text-right px-2 py-0 w-10 border-r border-slate-800 align-top">{lineNo ?? ""}</td>
                    <td className={cn("px-1 py-0 select-none w-4 align-top", pfxColor)}>{prefix}</td>
                    <td
                      className={cn("px-2 py-0 align-top", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre", text)}
                      dangerouslySetInnerHTML={{ __html: lineText !== undefined ? highlightLine(lineText) : "" }}
                    />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : content !== undefined ? (
        /* Raw content fallback (no diff data) */
        <pre
          className={cn("flex-1 overflow-auto text-[11px] font-mono leading-5 text-slate-300 p-3 min-h-0", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}
          dangerouslySetInnerHTML={{ __html: content.split("\n").map(highlightLine).join("\n") }}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-xs text-slate-600 italic">{absence}</div>
      )}
    </div>
  );
}

// ── Display name resolution ──────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveDisplayName(file: FileDiff): { name: string; detail: string } {
  const parts = file.relativePath.split("/");
  const fileName = parts[parts.length - 1];
  const stem = fileName.replace(/\.[^.]+$/, "");

  // Journeys: realms/<realm>/journeys/<JourneyName>/...
  const journeyIdx = parts.indexOf("journeys");
  if (journeyIdx >= 0 && parts.length > journeyIdx + 1) {
    const journeyName = parts[journeyIdx + 1];
    // Sub-path within journey (e.g., nodes/nodeId.json)
    const subPath = parts.slice(journeyIdx + 2).join("/");
    if (subPath && subPath !== `${journeyName}.json`) {
      return { name: `${journeyName} / ${subPath}`, detail: file.relativePath };
    }
    return { name: journeyName, detail: file.relativePath };
  }

  // Script config: scripts/scripts-config/{uuid}.json → parse name from content
  if (parts.includes("scripts-config") && UUID_RE.test(stem)) {
    const content = file.localContent ?? file.remoteContent;
    if (content) {
      try {
        const json = JSON.parse(content);
        if (typeof json.name === "string" && json.name) {
          return { name: json.name, detail: `${stem}` };
        }
      } catch { /* fall through */ }
    }
    return { name: stem, detail: file.relativePath };
  }

  // Script content: scripts/scripts-content/{type}/{ScriptName}.ext
  if (parts.includes("scripts-content")) {
    return { name: stem, detail: file.relativePath };
  }

  // Other JSON with name field
  if (fileName.endsWith(".json") && UUID_RE.test(stem)) {
    const content = file.localContent ?? file.remoteContent;
    if (content) {
      try {
        const json = JSON.parse(content);
        const name = json.name ?? json._id ?? json.displayName;
        if (typeof name === "string" && name) {
          return { name, detail: stem };
        }
      } catch { /* fall through */ }
    }
  }

  // Default: filename without extension
  return { name: stem, detail: parts.length > 1 ? file.relativePath : "" };
}

// ── File row ────────────────────────────────────────────────────────────────

type ViewMode = "diff" | "files";

const STATUS_STYLES: Record<FileDiff["status"], { badge: string; icon: string }> = {
  added:     { badge: "bg-emerald-100 text-emerald-700 border border-emerald-200", icon: "A" },
  removed:   { badge: "bg-red-100 text-red-700 border border-red-200",             icon: "D" },
  modified:  { badge: "bg-amber-100 text-amber-700 border border-amber-200",        icon: "M" },
  unchanged: { badge: "bg-slate-100 text-slate-500 border border-slate-200",        icon: "=" },
};

/** Auth scripts (under scripts-content/) and endpoint script files look
 *  better with wrap + format enabled out of the box — they're long, free-form
 *  source code rather than structured JSON config. */
function isScriptContentFile(file: FileDiff): boolean {
  const p = file.relativePath;
  if (p.includes("/scripts-content/") || p.startsWith("scripts-content/")) return true;
  if (/(?:^|\/)endpoints\/[^/]+\/[^/]+\.(?:js|groovy|ftl)$/i.test(p)) return true;
  return false;
}

function FileRow({ file, sourceLabel, targetLabel, extraActions, checked, onToggle, fileTasks = [], onRemoveFromTask }: { file: FileDiff; sourceLabel: string; targetLabel: string; extraActions?: React.ReactNode; checked?: boolean; onToggle?: () => void; fileTasks?: PromotionTask[]; onRemoveFromTask?: (task: PromotionTask, path: string) => void }) {
  const defaultOn = isScriptContentFile(file);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewMode>("diff");
  const [fullscreen, setFullscreen] = useState(false);
  const [wrap, setWrap] = useState(defaultOn);
  const [format, setFormat] = useState(defaultOn);

  // Optional ESV decoding: transform both sides when the scope toggle is
  // "decoded" so the diff operates on human-readable values.
  const [esvMode] = useEsvDisplayMode();
  const esvDecode = isEsvPath(file.relativePath) && esvMode === "decoded";
  const baseLocal  = esvDecode && file.localContent  != null ? decodeEsvContent(file.localContent)  : file.localContent;
  const baseRemote = esvDecode && file.remoteContent != null ? decodeEsvContent(file.remoteContent) : file.remoteContent;

  // When format is on, pretty-print both sides and recompute diffLines client-side
  const fmtLocal    = format && baseLocal  != null ? formatContent(baseLocal,  file.relativePath) : baseLocal;
  const fmtRemote   = format && baseRemote != null ? formatContent(baseRemote, file.relativePath) : baseRemote;
  const fmtDiffLines: DiffLine[] | undefined = useMemo(() => {
    if (!format && !esvDecode) return file.diffLines;
    if (fmtLocal != null && fmtRemote != null) return clientDiff(fmtLocal, fmtRemote);
    if (fmtRemote != null) return fmtRemote.split("\n").map((c) => ({ type: "added"   as const, content: c }));
    if (fmtLocal  != null) return fmtLocal.split("\n").map((c)  => ({ type: "removed" as const, content: c }));
    return file.diffLines;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, esvDecode, fmtLocal, fmtRemote]);
  const s = STATUS_STYLES[file.status];
  const hasDiff = !!file.diffLines?.length;
  const hasContent = file.localContent !== undefined || file.remoteContent !== undefined;

  const added   = file.linesAdded   ?? 0;
  const removed = file.linesRemoved ?? 0;

  const { name: displayName, detail: displayDetail } = resolveDisplayName(file);

  // ESC exits fullscreen
  useState(() => {
    if (typeof window === "undefined") return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const viewerContent = open && (
    view === "diff" && fmtDiffLines
      ? <DiffViewer lines={fmtDiffLines} fullscreen={fullscreen} wrap={wrap} />
      : <SideBySideViewer localContent={fmtLocal} remoteContent={fmtRemote} diffLines={fmtDiffLines} sourceLabel={sourceLabel} targetLabel={targetLabel} fullscreen={fullscreen} wrap={wrap} />
  );

  if (fullscreen && open) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col">
        {/* Fullscreen header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 border-b border-slate-800 shrink-0">
          <span className={cn("inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold shrink-0", s.badge)}>
            {s.icon}
          </span>
          <span className="text-sm text-slate-200 flex-1 truncate" title={file.relativePath}>
            {displayName}
            {displayDetail && <span className="text-slate-500 font-mono text-xs ml-2">{displayDetail}</span>}
          </span>
          {(added > 0 || removed > 0) && (
            <span className="shrink-0 flex items-center gap-1.5 text-xs font-mono">
              {added   > 0 && <span className="text-emerald-400">+{added}</span>}
              {removed > 0 && <span className="text-red-400">−{removed}</span>}
            </span>
          )}
          <div
            className="flex items-center rounded border border-slate-600 overflow-hidden text-[10px] shrink-0"
          >
            {(["diff", "files"] as ViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setView(m)}
                disabled={m === "files" && !hasContent}
                className={cn(
                  "px-2 py-0.5 capitalize transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                  view === m ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800"
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            title="Toggle line wrap"
            className={cn(
              "px-2 py-0.5 text-[10px] rounded border transition-colors shrink-0",
              wrap ? "bg-sky-600 text-white border-sky-600" : "text-slate-400 border-slate-600 hover:bg-slate-800"
            )}
          >
            Wrap
          </button>
          <button
            type="button"
            onClick={() => setFormat((f) => !f)}
            title="Auto-format content (JSON / JS / Groovy)"
            className={cn(
              "px-2 py-0.5 text-[10px] rounded border transition-colors shrink-0",
              format ? "bg-sky-600 text-white border-sky-600" : "text-slate-400 border-slate-600 hover:bg-slate-800"
            )}
          >
            Format
          </button>
          <button
            type="button"
            onClick={() => setFullscreen(false)}
            title="Exit fullscreen (Esc)"
            className="text-slate-400 hover:text-slate-200 transition-colors shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Fullscreen content */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {viewerContent}
        </div>
      </div>
    );
  }

  return (
    <div className="border border-slate-200 rounded overflow-hidden">
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-xs transition-colors",
          hasDiff ? "cursor-pointer hover:bg-slate-50" : "cursor-default",
          open ? "bg-slate-50 border-b border-slate-200" : "bg-white"
        )}
        onClick={() => hasDiff && setOpen((o) => !o)}
      >
        {onToggle !== undefined && (
          <input
            type="checkbox"
            checked={!!checked}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 w-3.5 h-3.5 accent-sky-600"
          />
        )}
        <span className={cn("inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold shrink-0", s.badge)}>
          {s.icon}
        </span>
        <span className="truncate flex-1 min-w-0" title={file.relativePath}>
          <span className="text-slate-700">{displayName}</span>
          {displayDetail && <span className="text-slate-400 font-mono text-[10px] ml-1.5">{displayDetail}</span>}
        </span>

        {(added > 0 || removed > 0) && (
          <span className="shrink-0 flex items-center gap-1.5 text-[10px] font-mono">
            {added   > 0 && <span className="text-emerald-600">+{added}</span>}
            {removed > 0 && <span className="text-red-500">−{removed}</span>}
          </span>
        )}

        {fileTasks.length > 0 && (
          <span className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {fileTasks.map((t) => {
              const sel = t.items.find((s) => s.scope === pathToTaskScopeAndItem(file.relativePath).scope);
              const isWholeScope = sel?.items === undefined;
              return (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 transition-colors"
                  title={isWholeScope
                    ? `In task "${t.name}" — whole ${sel?.scope} scope`
                    : `In task "${t.name}"`}
                >
                  <span className="truncate max-w-[120px]">{t.name}{isWholeScope ? " (all)" : ""}</span>
                  {onRemoveFromTask && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRemoveFromTask(t, file.relativePath); }}
                      className="leading-none text-[11px] -mr-0.5 text-indigo-400 hover:text-indigo-700 transition-colors"
                      title={`Remove from "${t.name}"`}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </span>
        )}

        {open && (
          <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center rounded border border-slate-300 overflow-hidden text-[10px]">
              {(["diff", "files"] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setView(m)}
                  disabled={m === "files" && !hasContent}
                  className={cn(
                    "px-2 py-0.5 capitalize transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                    view === m ? "bg-sky-600 text-white" : "text-slate-500 hover:bg-slate-100"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setWrap((w) => !w)}
              title="Toggle line wrap"
              className={cn(
                "px-2 py-0.5 text-[10px] rounded border transition-colors",
                wrap ? "bg-slate-900 text-white border-slate-900" : "text-slate-500 border-slate-300 hover:bg-slate-100"
              )}
            >
              Wrap
            </button>
            <button
              type="button"
              onClick={() => setFormat((f) => !f)}
              title="Auto-format content (JSON / JS / Groovy)"
              className={cn(
                "px-2 py-0.5 text-[10px] rounded border transition-colors",
                format ? "bg-slate-900 text-white border-slate-900" : "text-slate-500 border-slate-300 hover:bg-slate-100"
              )}
            >
              Format
            </button>
            {extraActions}
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              title="Fullscreen"
              className="text-slate-400 hover:text-slate-600 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            </button>
          </div>
        )}

        {hasDiff && (
          <span className="text-slate-400 shrink-0">{open ? "▲" : "▼"}</span>
        )}
      </div>

      {open && viewerContent}
    </div>
  );
}

// ── Scope grouping ──────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<string, string> = {
  "access-config": "Access Config", "audit": "Audit", "authorization": "Authorization Policies",
  "cookie-domains": "Cookie Domains", "cors": "CORS", "csp": "CSP", "custom-nodes": "Custom Nodes",
  "email-provider": "Email Provider", "email-templates": "Email Templates", "endpoints": "Custom Endpoints",
  "esvs": "Secrets & Variables", "idm-authentication-config": "IDM Authentication",
  "iga": "IGA Workflows", "internal-roles": "Internal Roles", "journeys": "Journeys",
  "kba": "KBA", "locales": "Locales", "managed-objects": "Managed Objects",
  "org-privileges": "Org Privileges", "password-policy": "Password Policy", "raw": "Raw Config",
  "realm-config": "Realm Config", "schedules": "Schedules", "scripts": "Scripts",
  "secret-mappings": "Secret Mappings", "service-objects": "Service Objects", "services": "Services",
  "sync": "Sync & Connectors", "telemetry": "Telemetry", "terms-conditions": "Terms & Conditions",
  "themes": "Themes", "ui": "UI Config",
};

interface ScopeGroup {
  scope: string;
  label: string;
  files: FileDiff[];
  /** Number of logical items (unique directories for dir-based scopes, else same as files.length) */
  itemCount: number;
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
  /** Item-level status counts (for dir-based scopes, deduped by item directory) */
  itemAdded: number;
  itemModified: number;
  itemRemoved: number;
  itemUnchanged: number;
}

function extractScope(relativePath: string): string {
  // Prefer the shared parser so all three layouts resolve consistently:
  //   realms/<realm>/<scope>/...   (upstream CLI)
  //   <realm>/<scope>/...           (vendored pull)
  //   <scope>/...                   (global scopes)
  // Falling back to the first segment keeps behavior stable for paths the
  // parser can't classify.
  const parsed = pathToScopeItem(relativePath);
  if (parsed) return parsed.scope;
  const parts = relativePath.split("/");
  if (parts[0] === "realms" && parts.length >= 3) return parts[2];
  return parts[0];
}

/**
 * True when the file is metadata (config/sidecar JSON) rather than an actual
 * script body. Currently covers two cases:
 *   - scripts scope: anything NOT under scripts-content/ is config metadata
 *   - endpoints scope: the <name>.json sidecar next to the <name>.js script
 */
function isMetadataFile(file: FileDiff, scope: string): boolean {
  if (scope === "scripts") {
    return !file.relativePath.includes("/scripts-content/");
  }
  if (scope === "endpoints") {
    return file.relativePath.endsWith(".json");
  }
  if (scope === "email-templates") {
    // Each template ships .md (content) + .json/.css/.html (metadata sidecars).
    // Treat anything that isn't the markdown body as metadata.
    return !file.relativePath.toLowerCase().endsWith(".md");
  }
  return false;
}

/**
 * Derive a sub-group key for scopes that benefit from one more level of
 * grouping. Scripts group by TYPE (the scripts-content/<TYPE>/ directory);
 * endpoints group by endpoint name. Returns null for scopes without a
 * natural sub-group.
 */
function subgroupKeyForFile(file: FileDiff, scope: string): string | null {
  if (scope === "scripts") {
    const m = file.relativePath.match(/\/scripts-content\/([^/]+)\//);
    return m ? m[1] : null;
  }
  if (scope === "endpoints") {
    const m = file.relativePath.match(/\/endpoints\/([^/]+)\//) ?? file.relativePath.match(/^endpoints\/([^/]+)\//);
    return m ? m[1] : null;
  }
  return null;
}

function humanizeSubgroup(scope: string, key: string): string {
  if (scope === "scripts") {
    // AUTHENTICATION_TREE_DECISION_NODE -> Authentication Tree Decision Node
    return key
      .split("_")
      .map((w) => (w.length ? w[0] + w.slice(1).toLowerCase() : w))
      .join(" ");
  }
  return key;
}

function groupByScope(files: FileDiff[]): ScopeGroup[] {
  const map = new Map<string, FileDiff[]>();
  for (const f of files) {
    const scope = extractScope(f.relativePath);
    if (!map.has(scope)) map.set(scope, []);
    map.get(scope)!.push(f);
  }

  // Scopes where each "item" is a directory containing multiple files
  const DIR_ITEM_SCOPES = new Set([
    "endpoints", "schedules", "custom-nodes", "journeys",
    "managed-objects", "email-templates", "themes", "iga-workflows",
  ]);

  return Array.from(map.entries())
    .map(([scope, scopeFiles]) => {
      const fileAdded     = scopeFiles.filter((f) => f.status === "added").length;
      const fileModified  = scopeFiles.filter((f) => f.status === "modified").length;
      const fileRemoved   = scopeFiles.filter((f) => f.status === "removed").length;
      const fileUnchanged = scopeFiles.filter((f) => f.status === "unchanged").length;

      // For dir-based scopes, compute item-level counts (dedup by item directory).
      // Each item's status = the "highest priority" status among its files:
      //   added > removed > modified > unchanged
      let itemCount = scopeFiles.length;
      let itemAdded = fileAdded, itemModified = fileModified;
      let itemRemoved = fileRemoved, itemUnchanged = fileUnchanged;

      if (DIR_ITEM_SCOPES.has(scope)) {
        const itemStatuses = new Map<string, FileDiff["status"]>();
        const priority: Record<string, number> = { added: 3, removed: 2, modified: 1, unchanged: 0 };
        for (const f of scopeFiles) {
          const { itemId } = pathToTaskScopeAndItem(f.relativePath);
          const key = itemId ?? f.relativePath;
          const prev = itemStatuses.get(key);
          if (!prev || (priority[f.status] ?? 0) > (priority[prev] ?? 0)) {
            itemStatuses.set(key, f.status);
          }
        }
        itemCount = itemStatuses.size;
        itemAdded = 0; itemModified = 0; itemRemoved = 0; itemUnchanged = 0;
        for (const status of itemStatuses.values()) {
          if (status === "added") itemAdded++;
          else if (status === "removed") itemRemoved++;
          else if (status === "modified") itemModified++;
          else itemUnchanged++;
        }
      }

      return {
        scope,
        label: SCOPE_LABELS[scope] ?? scope.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        files: scopeFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
        itemCount,
        added: fileAdded, modified: fileModified, removed: fileRemoved, unchanged: fileUnchanged,
        itemAdded, itemModified, itemRemoved, itemUnchanged,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Pagination ───────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500];
const DEFAULT_PAGE_SIZE = 20;

function Pagination({
  page, total, pageSize, onChange, onPageSizeChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (p: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const pages = Math.ceil(total / pageSize);
  const [inputVal, setInputVal] = useState("");

  if (total === 0) return null;
  const start = page * pageSize + 1;
  const end   = Math.min((page + 1) * pageSize, total);

  function commitPageInput() {
    const n = parseInt(inputVal, 10);
    if (!isNaN(n) && n >= 1 && n <= pages) onChange(n - 1);
    setInputVal("");
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100 text-[10px] text-slate-500">
      <div className="flex items-center gap-1.5">
        <span>{start}–{end} of {total}</span>
        <span className="text-slate-300">·</span>
        <label className="flex items-center gap-1">
          <span>Per page:</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="border border-slate-200 rounded px-1 py-0 text-[10px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-sky-400"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          {/* First */}
          <button
            type="button"
            disabled={page === 0}
            onClick={() => onChange(0)}
            title="First page"
            className="px-2 py-0.5 rounded border border-slate-200 disabled:opacity-30 hover:bg-slate-50 transition-colors"
          >
            «
          </button>
          <button
            type="button"
            disabled={page === 0}
            onClick={() => onChange(page - 1)}
            className="px-2 py-0.5 rounded border border-slate-200 disabled:opacity-30 hover:bg-slate-50 transition-colors"
          >
            ‹ Prev
          </button>
          {/* Page input */}
          <div className="flex items-center gap-1 px-1">
            <input
              type="number"
              min={1}
              max={pages}
              value={inputVal}
              placeholder={String(page + 1)}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitPageInput(); }}
              onBlur={commitPageInput}
              className="w-10 text-center border border-slate-200 rounded px-1 py-0 text-[10px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-sky-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span>/ {pages}</span>
          </div>
          <button
            type="button"
            disabled={page >= pages - 1}
            onClick={() => onChange(page + 1)}
            className="px-2 py-0.5 rounded border border-slate-200 disabled:opacity-30 hover:bg-slate-50 transition-colors"
          >
            Next ›
          </button>
          {/* Last */}
          <button
            type="button"
            disabled={page >= pages - 1}
            onClick={() => onChange(pages - 1)}
            title="Last page"
            className="px-2 py-0.5 rounded border border-slate-200 disabled:opacity-30 hover:bg-slate-50 transition-colors"
          >
            »
          </button>
        </div>
      )}
    </div>
  );
}

// ── Status sub-group (collapsible) ──────────────────────────────────────────

function StatusGroup({
  label, files, color, sourceLabel, targetLabel,
}: {
  label: string;
  files: FileDiff[];
  color: string;
  sourceLabel: string;
  targetLabel: string;
}) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn("flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide px-1", color)}
      >
        <span className={cn("transition-transform inline-block", open ? "" : "-rotate-90")}>▼</span>
        {label} ({files.length})
      </button>
      {open && files.map((f) => (
        <FileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} />
      ))}
    </div>
  );
}

// ── Journey tree view ────────────────────────────────────────────────────────

const JOURNEY_STATUS_STYLES: Record<string, { dot: string; badge: string; label: string }> = {
  modified:  { dot: "bg-amber-400",   badge: "bg-amber-100 text-amber-700 border-amber-200", label: "M" },
  added:     { dot: "bg-emerald-400", badge: "bg-emerald-100 text-emerald-700 border-emerald-200", label: "A" },
  removed:   { dot: "bg-red-400",     badge: "bg-red-100 text-red-700 border-red-200", label: "D" },
  unchanged: { dot: "bg-slate-300",   badge: "bg-slate-100 text-slate-500 border-slate-200", label: "—" },
};

function findScriptFiles(files: FileDiff[], uuid: string, name: string): FileDiff[] {
  return files.filter((f) => {
    if (f.relativePath.includes(`/scripts-config/${uuid}.json`)) return true;
    if (f.relativePath.includes("/scripts-content/")) {
      const stem = f.relativePath.split("/").pop()?.replace(/\.[^.]+$/, "");
      return stem === name;
    }
    return false;
  });
}

/** Find which node UUID in a journey uses a given script UUID.
 *  Searches diff files first; falls back to the journey-node API for unchanged node configs. */
async function findNodeIdForScript(
  scriptUuid: string,
  journeyName: string,
  nodeInfos: JourneyNodeInfo[],
  files: FileDiff[],
  env: string,
): Promise<string | null> {
  // 1. Search diff files (fast — works when the node config was also changed)
  for (const f of files) {
    if (!f.relativePath.includes(`/journeys/${journeyName}/nodes/`)) continue;
    const content = f.localContent ?? f.remoteContent ?? "";
    if (content.includes(scriptUuid)) {
      const m = f.relativePath.match(/\/([^/]+)\.json$/);
      if (m) return m[1];
    }
  }
  // 2. Fetch node configs from API for ScriptedDecisionNode entries
  const candidates = nodeInfos.filter((n) => n.nodeType === "ScriptedDecisionNode");
  for (const nodeInfo of candidates) {
    try {
      const params = new URLSearchParams({ environment: env, journey: journeyName, nodeId: nodeInfo.uuid });
      const res = await fetch(`/api/push/journey-node?${params}`);
      if (!res.ok) continue;
      const data = await res.json() as { file?: { content?: string } };
      if ((data.file?.content ?? "").includes(scriptUuid)) return nodeInfo.uuid;
    } catch { /* ignore */ }
  }
  return null;
}

type ScriptUsageRef = { journey: string; nodeName: string; nodeType: string; nodeUuid: string; env: string };

function JourneyScriptRow({ sc, files, sourceLabel, targetLabel, journeyName, nodeInfos, sourceEnv, targetEnv, onViewInJourney }: {
  sc: JourneyScript;
  files: FileDiff[];
  sourceLabel: string;
  targetLabel: string;
  journeyName: string;
  nodeInfos: JourneyNodeInfo[];
  sourceEnv: string;
  targetEnv: string;
  onViewInJourney: (nodeId: string | null) => void;
}) {
  const [open, setOpen]             = useState(false);
  const [finding, setFinding]       = useState(false);
  const [usageOpen, setUsageOpen]   = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageData, setUsageData]   = useState<ScriptUsageRef[] | null>(null);

  const ss = JOURNEY_STATUS_STYLES[sc.status] ?? JOURNEY_STATUS_STYLES.unchanged;
  const scriptFiles = useMemo(() => findScriptFiles(files, sc.uuid, sc.name), [files, sc.uuid, sc.name]);
  const canExpand = scriptFiles.length > 0;

  const handleViewInJourney = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const env = sourceEnv || targetEnv;
    if (!env) { onViewInJourney(null); return; }
    setFinding(true);
    const nodeId = await findNodeIdForScript(sc.uuid, journeyName, nodeInfos, files, env);
    setFinding(false);
    onViewInJourney(nodeId);
  }, [sc.uuid, journeyName, nodeInfos, files, sourceEnv, targetEnv, onViewInJourney]);

  const handleFindUsage = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (usageOpen) { setUsageOpen(false); return; }
    setUsageOpen(true);
    if (usageData !== null) return; // already loaded
    setUsageLoading(true);
    try {
      const envs = [...new Set([sourceEnv, targetEnv].filter(Boolean))];
      const results = await Promise.all(
        envs.map((env) =>
          fetch(`/api/analyze/script-usage?env=${encodeURIComponent(env)}&scriptId=${encodeURIComponent(sc.uuid)}`)
            .then((r) => r.json())
            .then((d) => (d.usedBy ?? []).map((u: Omit<ScriptUsageRef, "env">) => ({ ...u, env })))
            .catch(() => [] as ScriptUsageRef[])
        )
      );
      // Deduplicate by journey+node across envs
      const seen = new Set<string>();
      const merged: ScriptUsageRef[] = [];
      for (const ref of results.flat()) {
        const key = `${ref.journey}::${ref.nodeUuid}`;
        if (!seen.has(key)) { seen.add(key); merged.push(ref); }
      }
      setUsageData(merged);
    } finally {
      setUsageLoading(false);
    }
  }, [sc.uuid, sourceEnv, targetEnv, usageOpen, usageData]);

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 text-xs rounded group",
          canExpand && "cursor-pointer hover:bg-slate-50",
        )}
        onClick={() => canExpand && setOpen((o) => !o)}
      >
        <span className="w-3 shrink-0" />
        <svg className="w-3 h-3 text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
        </svg>
        <span className="text-slate-600 truncate flex-1 min-w-0" title={sc.uuid}>{sc.name}</span>
        <span className={cn("text-[10px] px-1 py-0 rounded border shrink-0", ss.badge)}>{ss.label}</span>
        {/* Find Usage button */}
        <button
          type="button"
          title="Find usage in journeys"
          onClick={handleFindUsage}
          className={cn(
            "shrink-0 px-1.5 py-0 text-[10px] font-medium rounded transition-colors",
            usageOpen
              ? "bg-violet-100 text-violet-700"
              : "text-slate-400 hover:text-violet-600 hover:bg-violet-50"
          )}
        >
          Find Usage
        </button>
        {/* View in journey button */}
        <button
          type="button"
          title="View in journey graph"
          disabled={finding}
          onClick={handleViewInJourney}
          className="text-slate-400 hover:text-sky-500 transition-colors shrink-0 disabled:opacity-50"
        >
          {finding
            ? <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
            : <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" /></svg>
          }
        </button>
        {canExpand && <span className="text-slate-400 text-[10px] shrink-0">{open ? "▲" : "▼"}</span>}
      </div>
      {/* Usage panel */}
      {usageOpen && (
        <div className="ml-6 mt-0.5 mb-1 px-2.5 py-2 rounded bg-violet-50 border border-violet-100 text-xs">
          {usageLoading ? (
            <p className="text-slate-400">Searching…</p>
          ) : !usageData || usageData.length === 0 ? (
            <p className="text-slate-400 italic">Not used in any journey.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] text-violet-600 font-semibold uppercase tracking-wide mb-1">
                Used in {usageData.length} {usageData.length === 1 ? "place" : "places"}
              </p>
              {usageData.map((ref, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                  <span className="text-slate-700 font-medium">{ref.journey}</span>
                  <span className="text-slate-400">→</span>
                  <span className="text-slate-600">{ref.nodeName}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{ref.nodeType}</span>
                  {ref.env && (
                    <span className="text-[9px] text-violet-500 bg-violet-100 px-1 rounded">{ref.env}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {open && scriptFiles.length > 0 && (
        <div className="ml-4 mt-1 space-y-1">
          {scriptFiles.map((f) => (
            <FileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} />
          ))}
        </div>
      )}
    </div>
  );
}

function JourneyNode({ node, depth, forceOpen, forceSeq, showScripts, showNodes, files, sourceLabel, targetLabel, sourceEnv, targetEnv, ancestorPath = [], selectedPaths, onTogglePath, hideUnchanged = false }: { node: JourneyTreeNode; depth: number; forceOpen?: boolean; forceSeq?: number; showScripts?: boolean; showNodes?: boolean; files: FileDiff[]; sourceLabel: string; targetLabel: string; sourceEnv: string; targetEnv: string; ancestorPath?: NavEntry[]; selectedPaths?: Set<string>; onTogglePath?: (path: string) => void; hideUnchanged?: boolean }) {
  const [open, setOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphInitialFocusNodeId, setGraphInitialFocusNodeId] = useState<string | null>(null);

  // Find-usage state (where this journey is used as an inner journey)
  type JourneyUsageRef = { journey: string; nodeName: string; nodeType: string; nodeUuid: string; env: string };
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageData, setUsageData] = useState<JourneyUsageRef[] | null>(null);
  const [usageGraphTarget, setUsageGraphTarget] = useState<{ journeyName: string; nodeUuid: string } | null>(null);

  const handleViewScriptInJourney = useCallback((nodeId: string | null) => {
    setGraphInitialFocusNodeId(nodeId);
    setGraphOpen(true);
  }, []);

  const handleFindUsage = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (usageOpen) { setUsageOpen(false); return; }
    setUsageOpen(true);
    if (usageData !== null) return;
    setUsageLoading(true);
    try {
      const envs = [...new Set([sourceEnv, targetEnv].filter(Boolean))];
      const results = await Promise.all(
        envs.map((env) =>
          fetch(`/api/analyze/journey-usage?env=${encodeURIComponent(env)}&journeyName=${encodeURIComponent(node.name)}`)
            .then((r) => r.json())
            .then((d) => (d.usedBy ?? []).map((u: Omit<JourneyUsageRef, "env">) => ({ ...u, env })))
            .catch(() => [] as JourneyUsageRef[])
        )
      );
      const seen = new Set<string>();
      const merged: JourneyUsageRef[] = [];
      for (const ref of results.flat()) {
        const key = `${ref.env}::${ref.journey}::${ref.nodeUuid}`;
        if (!seen.has(key)) { seen.add(key); merged.push(ref); }
      }
      setUsageData(merged);
    } finally {
      setUsageLoading(false);
    }
  }, [usageOpen, usageData, node.name, sourceEnv, targetEnv]);

  const usageGraphFile = useMemo(
    () => usageGraphTarget
      ? files.find((f) => f.relativePath.endsWith(`/journeys/${usageGraphTarget.journeyName}/${usageGraphTarget.journeyName}.json`))
      : undefined,
    [files, usageGraphTarget],
  );
  const hasChildren =
    node.subJourneys.length > 0 ||
    (showScripts && node.scripts.length > 0) ||
    (showNodes && node.nodes.length > 0);
  const s = JOURNEY_STATUS_STYLES[node.status] ?? JOURNEY_STATUS_STYLES.unchanged;

  const prevSeq = useRef(forceSeq);
  if (forceSeq !== undefined && forceSeq !== prevSeq.current) {
    prevSeq.current = forceSeq;
    if (forceOpen !== undefined) setOpen(forceOpen);
  }

  const journeyFile = useMemo(
    () => files.find((f) => f.relativePath.endsWith(`/journeys/${node.name}/${node.name}.json`)),
    [files, node.name],
  );
  const canShowGraph = !!(journeyFile?.localContent || journeyFile?.remoteContent) || node.nodes.length > 0;

  // Path to pass to children: ancestors + self (so children can trace back to entry journey)
  const childAncestorPath = useMemo<NavEntry[]>(
    () => [...ancestorPath, { name: node.name, localContent: journeyFile?.localContent, remoteContent: journeyFile?.remoteContent, nodeInfos: node.nodes }],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ancestorPath, node.name, journeyFile?.localContent, journeyFile?.remoteContent, node.nodes],
  );

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 rounded group",
          hasChildren && "cursor-pointer hover:bg-slate-50",
        )}
        onClick={() => hasChildren && setOpen((o) => !o)}
      >
        {depth === 0 && onTogglePath !== undefined && (
          <input
            type="checkbox"
            checked={selectedPaths?.has(`journeys/${node.name}`) ?? false}
            onChange={() => onTogglePath(`journeys/${node.name}`)}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 w-3.5 h-3.5 accent-sky-600"
          />
        )}
        <span className="w-3 shrink-0 text-slate-400 text-[10px]">
          {hasChildren ? (open ? "▾" : "▸") : ""}
        </span>
        <span className={cn("w-2 h-2 rounded-full shrink-0", s.dot)} />
        {node.isEntry ? (
          <svg className="w-3.5 h-3.5 shrink-0 text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        )}
        <span className={cn("text-xs flex-1 min-w-0 truncate", depth === 0 ? "font-semibold text-slate-800" : "text-slate-700")} title={node.name}>
          {node.name}
        </span>
        {node.status !== "unchanged" && (
          <span className={cn("text-[10px] px-1 py-0 rounded border shrink-0", s.badge)}>{s.label}</span>
        )}
        {node.isEntry && (
          <span className="text-[10px] px-1 py-0 rounded bg-sky-100 text-sky-700 border border-sky-200 shrink-0">Entry</span>
        )}
        {canShowGraph && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setGraphOpen(true); }}
            title="View flow graph"
            className="text-slate-400 hover:text-sky-500 transition-colors shrink-0 ml-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
            </svg>
          </button>
        )}
        <button
          type="button"
          title="Find usage as inner journey"
          onClick={handleFindUsage}
          className={cn(
            "shrink-0 px-1.5 py-0 text-[10px] font-medium rounded transition-colors",
            usageOpen
              ? "bg-violet-100 text-violet-700"
              : "text-slate-400 hover:text-violet-600 hover:bg-violet-50"
          )}
        >
          Find Usage
        </button>
      </div>
      {usageOpen && (
        <div className="ml-6 mt-0.5 mb-1 px-2.5 py-2 rounded bg-violet-50 border border-violet-100 text-xs">
          {usageLoading ? (
            <p className="text-slate-400">Searching…</p>
          ) : !usageData || usageData.length === 0 ? (
            <p className="text-slate-400 italic">Not used as an inner journey.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] text-violet-600 font-semibold uppercase tracking-wide mb-1">
                Used in {usageData.length} {usageData.length === 1 ? "place" : "places"}
              </p>
              {usageData.map((ref, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setUsageGraphTarget({ journeyName: ref.journey, nodeUuid: ref.nodeUuid });
                    }}
                    className="text-violet-700 hover:text-violet-900 hover:underline font-medium"
                  >
                    {ref.journey}
                  </button>
                  <span className="text-slate-400">→</span>
                  <span className="text-slate-600">{ref.nodeName}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{ref.nodeType}</span>
                  {ref.env && (
                    <span className="text-[9px] text-violet-500 bg-violet-100 px-1 rounded">{ref.env}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {open && hasChildren && (() => {
        // When "Hide unchanged" is on, drop unchanged sub-journeys, scripts,
        // and individual nodes so the expanded branch shows only deltas.
        const visibleSubs = hideUnchanged
          ? node.subJourneys.filter((s) => s.status !== "unchanged")
          : node.subJourneys;
        const visibleScripts = hideUnchanged
          ? node.scripts.filter((s) => s.status !== "unchanged")
          : node.scripts;
        const visibleNodes = hideUnchanged
          ? node.nodes.filter((n) => n.status !== "unchanged")
          : node.nodes;
        return (
          <div className="ml-4 border-l border-slate-200 pl-3 mt-0.5 space-y-0.5">
            {visibleSubs.map((child) => (
              <JourneyNode key={child.name} node={child} depth={depth + 1} forceOpen={forceOpen} forceSeq={forceSeq} showScripts={showScripts} showNodes={showNodes} files={files} sourceLabel={sourceLabel} targetLabel={targetLabel} sourceEnv={sourceEnv} targetEnv={targetEnv} ancestorPath={childAncestorPath} selectedPaths={selectedPaths} onTogglePath={onTogglePath} hideUnchanged={hideUnchanged} />
            ))}
            {showScripts && visibleScripts.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {visibleScripts.map((sc) => (
                  <JourneyScriptRow
                    key={sc.uuid}
                    sc={sc}
                    files={files}
                    sourceLabel={sourceLabel}
                    targetLabel={targetLabel}
                    journeyName={node.name}
                    nodeInfos={node.nodes}
                    sourceEnv={sourceEnv}
                    targetEnv={targetEnv}
                    onViewInJourney={handleViewScriptInJourney}
                  />
                ))}
              </div>
            )}
            {showNodes && visibleNodes.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {visibleNodes.map((nd) => {
                  const ns = JOURNEY_STATUS_STYLES[nd.status] ?? JOURNEY_STATUS_STYLES.unchanged;
                  const label = nd.displayName || nd.name;
                  return (
                    <div key={nd.uuid} className="flex items-center gap-1.5 py-0.5 text-xs">
                      <span className="w-3 shrink-0" />
                      <svg className="w-3 h-3 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
                      </svg>
                      <span className="text-slate-700 truncate" title={`${nd.nodeType} (${nd.uuid})`}>{label}</span>
                      <span className="text-[10px] text-slate-400 shrink-0">{nd.nodeType}</span>
                      <span className={cn("text-[10px] px-1 py-0 rounded border shrink-0", ns.badge)}>{ns.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
      {graphOpen && (
        <JourneyDiffGraphModal
          journeyName={node.name}
          localContent={journeyFile?.localContent}
          remoteContent={journeyFile?.remoteContent}
          nodeInfos={node.nodes}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
          sourceEnv={sourceEnv}
          targetEnv={targetEnv}
          files={files}
          journeyTree={[node]}
          ancestorPath={ancestorPath}
          initialFocusNodeId={graphInitialFocusNodeId ?? undefined}
          onClose={() => { setGraphOpen(false); setGraphInitialFocusNodeId(null); }}
        />
      )}
      {usageGraphTarget && (
        <JourneyDiffGraphModal
          journeyName={usageGraphTarget.journeyName}
          localContent={usageGraphFile?.localContent}
          remoteContent={usageGraphFile?.remoteContent}
          nodeInfos={[]}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
          sourceEnv={sourceEnv}
          targetEnv={targetEnv}
          files={files}
          initialFocusNodeId={usageGraphTarget.nodeUuid}
          onClose={() => setUsageGraphTarget(null)}
        />
      )}
    </div>
  );
}

type JourneyStatusFilter = "all" | "modified" | "added" | "removed";

/** Count entry journey statuses (root level only). */
function countEntryByStatus(nodes: JourneyTreeNode[]): { modified: number; added: number; removed: number } {
  let modified = 0, added = 0, removed = 0;
  for (const n of nodes) {
    if (n.status === "modified") modified++;
    else if (n.status === "added") added++;
    else if (n.status === "removed") removed++;
  }
  return { modified, added, removed };
}

/** Filter entry journeys by status (root level) and search (any depth). */
function filterJourneyTree(
  tree: JourneyTreeNode[],
  statusFilter: JourneyStatusFilter,
  searchQ: string,
  hideUnchanged = false,
): JourneyTreeNode[] {
  function nameMatchesInTree(n: JourneyTreeNode): boolean {
    if (n.name.toLowerCase().includes(searchQ)) return true;
    return n.subJourneys.some(nameMatchesInTree);
  }

  return tree.filter((entry) => {
    if (hideUnchanged && entry.status === "unchanged") return false;
    const statusOk = statusFilter === "all" || entry.status === statusFilter;
    const nameOk = !searchQ || nameMatchesInTree(entry);
    return statusOk && nameOk;
  });
}

function JourneyTreeSection({ tree, forceOpen: parentForceOpen, forceSeq: parentForceSeq, files, sourceLabel, targetLabel, sourceEnv, targetEnv, selectedPaths, onTogglePath, hideUnchanged = false }: { tree: JourneyTreeNode[]; forceOpen?: boolean; forceSeq?: number; files: FileDiff[]; sourceLabel: string; targetLabel: string; sourceEnv: string; targetEnv: string; selectedPaths?: Set<string>; onTogglePath?: (path: string) => void; hideUnchanged?: boolean }) {
  const [open, setOpen] = useState(true);
  const [statusFilter, setStatusFilter] = useState<JourneyStatusFilter>("all");
  const [searchQ, setSearchQ] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showScripts, setShowScripts] = useState(true);
  const [showNodes, setShowNodes] = useState(false);
  const [localForceOpen, setLocalForceOpen] = useState<boolean | undefined>(undefined);
  const [forceSeq, setForceSeq] = useState(0);

  // Respond to parent expand/collapse all — only open/close this section, not children
  const prevParentSeq = useRef(parentForceSeq);
  if (parentForceSeq !== undefined && parentForceSeq !== prevParentSeq.current) {
    prevParentSeq.current = parentForceSeq;
    if (parentForceOpen !== undefined) setOpen(parentForceOpen);
  }

  const expandAll = () => { setLocalForceOpen(true); setForceSeq((s) => s + 1); };
  const collapseAll = () => { setLocalForceOpen(false); setForceSeq((s) => s + 1); };

  const counts = useMemo(() => countEntryByStatus(tree), [tree]);
  const totalChanged = counts.modified + counts.added + counts.removed;

  const filtered = useMemo(
    () => filterJourneyTree(tree, statusFilter, searchQ.toLowerCase(), hideUnchanged),
    [tree, statusFilter, searchQ, hideUnchanged],
  );

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-sm font-semibold text-slate-700 flex-1">Journeys</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
          {totalChanged} changed
        </span>
        <span className="text-[10px] text-slate-400">{tree.length} entry journeys</span>
        <span className="text-slate-400 text-xs shrink-0">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="space-y-0">
          {/* Filter bar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 bg-white">
            {/* Expand/Collapse All */}
            <button type="button" onClick={expandAll} className="text-[10px] text-slate-500 hover:text-slate-700 transition-colors shrink-0">Expand All</button>
            <button type="button" onClick={collapseAll} className="text-[10px] text-slate-500 hover:text-slate-700 transition-colors shrink-0">Collapse All</button>
            <span className="text-slate-300 shrink-0">|</span>
            {/* Status filter pills */}
            <div className="flex rounded border border-slate-300 overflow-hidden text-[10px] shrink-0">
              {([
                { value: "all" as JourneyStatusFilter, label: "All" },
                { value: "modified" as JourneyStatusFilter, label: `Modified (${counts.modified})` },
                { value: "added" as JourneyStatusFilter, label: `Added (${counts.added})` },
                { value: "removed" as JourneyStatusFilter, label: `Removed (${counts.removed})` },
              ]).map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => { setStatusFilter(f.value); setPage(0); }}
                  className={cn(
                    "px-2 py-0.5 transition-colors",
                    statusFilter === f.value
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-500 hover:bg-slate-50"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Search */}
            <input
              type="text"
              value={searchQ}
              onChange={(e) => { setSearchQ(e.target.value); setPage(0); }}
              placeholder="Search journeys…"
              className="flex-1 text-xs rounded border border-slate-200 px-2.5 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            {searchQ && (
              <button type="button" onClick={() => setSearchQ("")} className="text-xs text-slate-400 hover:text-slate-600">
                Clear
              </button>
            )}
            <span className="text-slate-300 shrink-0">|</span>
            <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={showScripts}
                onChange={(e) => setShowScripts(e.target.checked)}
                className="accent-sky-600"
              />
              Show scripts
            </label>
            <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={showNodes}
                onChange={(e) => setShowNodes(e.target.checked)}
                className="accent-sky-600"
              />
              Show nodes
            </label>
            <span className="text-[10px] text-slate-400 shrink-0">{filtered.length} / {tree.length}</span>
          </div>

          {/* Tree */}
          <div className="p-4 space-y-0.5">
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No journeys match the filter.</p>
            ) : (
              filtered.slice(page * pageSize, (page + 1) * pageSize).map((node) => (
                <JourneyNode key={node.name} node={node} depth={0} forceOpen={localForceOpen} forceSeq={forceSeq} showScripts={showScripts} showNodes={showNodes} files={files} sourceLabel={sourceLabel} targetLabel={targetLabel} sourceEnv={sourceEnv} targetEnv={targetEnv} selectedPaths={selectedPaths} onTogglePath={onTogglePath} hideUnchanged={hideUnchanged} />
              ))
            )}
          </div>
          <Pagination
            page={page} total={filtered.length} pageSize={pageSize}
            onChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          />
        </div>
      )}
    </div>
  );
}

// ── Scope section ───────────────────────────────────────────────────────────

function filterFiles(files: FileDiff[], query: string): FileDiff[] {
  if (!query) return files;
  const q = query.toLowerCase();
  return files.filter((f) => {
    const { name, detail } = resolveDisplayName(f);
    return name.toLowerCase().includes(q) || detail.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q);
  });
}

/** Extract the canonical ESV name from an esvs/{variables|secrets}/... path. */
function esvNameFromRelPath(rel: string): string | null {
  const m = rel.match(/^esvs\/(?:variables|secrets)\/(.+)$/);
  if (!m) return null;
  const filename = m[1].split("/").pop() ?? "";
  const base = filename
    .replace(/\.variable\.json$/i, "")
    .replace(/\.secret\.json$/i, "")
    .replace(/\.json$/i, "");
  let n = base.toLowerCase();
  if (n.startsWith("esv-")) n = n.slice(4);
  else if (n.startsWith("esv.")) n = n.slice(4);
  return (n.replace(/\./g, "-")) || null;
}

interface EsvUsageRef { path: string; line: number; snippet: string; form: string }

/** Lightbox modal showing a single file at a highlighted line. */
function FilePreviewModal({ env, path, line, onClose }: { env: string; path: string; line: number; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setContent(null);
    setError(null);
    fetch(`/api/configs/${encodeURIComponent(env)}/file?path=${encodeURIComponent(path)}`, { signal: ctl.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => setContent(d.content ?? ""))
      .catch((e) => { if ((e as Error).name !== "AbortError") setError((e as Error).message); });
    return () => ctl.abort();
  }, [env, path]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content).catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-[min(1100px,calc(100vw-40px))] h-[min(800px,calc(100vh-40px))] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-700 bg-slate-800 shrink-0">
          <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wide shrink-0">{env}</span>
          <span className="text-xs font-mono text-slate-300 truncate flex-1 min-w-0" title={path}>{path}</span>
          <span className="text-[10px] text-slate-400 shrink-0">line {line}</span>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!content}
            className="text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-30 transition-colors shrink-0"
            title="Copy file contents"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors shrink-0"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {error ? (
            <div className="p-4 text-sm text-rose-400">Failed to load: {error}</div>
          ) : content === null ? (
            <div className="p-4 text-sm text-slate-400">Loading…</div>
          ) : (
            <FileContentViewer content={content} fileName={path} highlightLine={line} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Wraps FileRow for ESV variable/secret files, adding an inline Find Usage panel. */
function EsvScopeFileRow({ file, sourceLabel, targetLabel, sourceEnv, targetEnv, checked, onToggle, fileTasks = [], onRemoveFromTask }: {
  file: FileDiff;
  sourceLabel: string;
  targetLabel: string;
  sourceEnv: string;
  targetEnv: string;
  checked?: boolean;
  onToggle?: () => void;
  fileTasks?: PromotionTask[];
  onRemoveFromTask?: (task: PromotionTask, path: string) => void;
}) {
  const esvName = useMemo(() => esvNameFromRelPath(file.relativePath), [file.relativePath]);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageData, setUsageData] = useState<Record<string, EsvUsageRef[]> | null>(null);
  const [preview, setPreview] = useState<{ env: string; path: string; line: number } | null>(null);

  const fetchUsage = useCallback(async () => {
    if (usageData !== null || !esvName) return;
    setUsageLoading(true);
    try {
      const envs = [...new Set([sourceEnv, targetEnv].filter(Boolean))];
      const results = await Promise.all(
        envs.map((env) =>
          fetch(`/api/analyze/esv-usages?env=${encodeURIComponent(env)}&name=${encodeURIComponent(esvName)}`)
            .then((r) => r.json())
            .then((d) => [env, (d.references ?? []) as EsvUsageRef[]] as const)
            .catch(() => [env, [] as EsvUsageRef[]] as const)
        )
      );
      const map: Record<string, EsvUsageRef[]> = {};
      for (const [env, refs] of results) map[env] = refs;
      setUsageData(map);
    } finally {
      setUsageLoading(false);
    }
  }, [esvName, sourceEnv, targetEnv, usageData]);

  const handleFindUsage = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !usageOpen;
    setUsageOpen(next);
    if (next) fetchUsage();
  }, [usageOpen, fetchUsage]);

  const findUsageButton = esvName ? (
    <button
      type="button"
      onClick={handleFindUsage}
      className={cn(
        "px-1.5 py-0.5 text-[10px] font-medium rounded border transition-colors",
        usageOpen
          ? "bg-violet-100 text-violet-700 border-violet-200"
          : "text-slate-500 border-slate-300 hover:text-violet-600 hover:bg-violet-50 hover:border-violet-200"
      )}
    >
      Find Usage
    </button>
  ) : null;

  const envOrder = [...new Set([sourceEnv, targetEnv].filter(Boolean))];
  const totalRefs = usageData ? envOrder.reduce((n, env) => n + (usageData[env]?.length ?? 0), 0) : 0;

  return (
    <div>
      <FileRow file={file} sourceLabel={sourceLabel} targetLabel={targetLabel} extraActions={findUsageButton} checked={checked} onToggle={onToggle} fileTasks={fileTasks} onRemoveFromTask={onRemoveFromTask} />
      {preview && (
        <FilePreviewModal env={preview.env} path={preview.path} line={preview.line} onClose={() => setPreview(null)} />
      )}
      {usageOpen && (
        <div className="mx-1 mb-1 px-2.5 py-2 rounded bg-violet-50 border border-violet-100 text-xs">
          {usageLoading ? (
            <p className="text-slate-400">Searching…</p>
          ) : !usageData || totalRefs === 0 ? (
            <p className="text-slate-400 italic">Not referenced in {envOrder.length === 1 ? "this env" : "either env"}.</p>
          ) : (
            <div className="space-y-2">
              {envOrder.map((env) => {
                const refs = usageData[env] ?? [];
                if (refs.length === 0) return null;
                return (
                  <div key={env}>
                    <p className="text-[10px] text-violet-700 font-semibold uppercase tracking-wide mb-1">
                      <span className="font-mono">{env}</span> · {refs.length} reference{refs.length === 1 ? "" : "s"}
                    </p>
                    <div className="space-y-0.5">
                      {refs.slice(0, 25).map((r, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setPreview({ env, path: r.path, line: r.line }); }}
                          className="w-full flex items-start gap-2 text-[11px] font-mono text-left rounded px-1 py-0.5 border-l-2 border-transparent hover:bg-violet-100 hover:border-violet-400 transition-colors"
                          title="Open file at this line"
                        >
                          <span className="shrink-0 text-violet-500 tabular-nums w-8 text-right">{r.line}</span>
                          <span className="shrink-0 text-violet-700 hover:underline truncate max-w-[320px]" title={r.path}>{r.path}</span>
                          <span className="flex-1 text-slate-500 break-all">{r.snippet}</span>
                        </button>
                      ))}
                      {refs.length > 25 && (
                        <p className="text-[10px] text-violet-500 italic">… and {refs.length - 25} more</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Wraps FileRow for script files, adding an inline Find Usage panel. */
function ScriptScopeFileRow({ file, sourceLabel, targetLabel, sourceEnv, targetEnv, groupFiles, allFiles, checked, onToggle, fileTasks = [], onRemoveFromTask }: {
  file: FileDiff;
  sourceLabel: string;
  targetLabel: string;
  sourceEnv: string;
  targetEnv: string;
  groupFiles: FileDiff[];
  allFiles: FileDiff[];
  checked?: boolean;
  onToggle?: () => void;
  fileTasks?: PromotionTask[];
  onRemoveFromTask?: (task: PromotionTask, path: string) => void;
}) {
  const [usageOpen, setUsageOpen]       = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageData, setUsageData]       = useState<ScriptUsageRef[] | null>(null);
  const [graphTarget, setGraphTarget]   = useState<{ journeyName: string; nodeUuid: string } | null>(null);

  // Extract UUID from config file path, or script name from content file path.
  // Config files (scripts-config/<uuid>.json) are skipped by the diff builder by default,
  // so content files (scripts-content/<type>/<name>.js) are what normally appears in the list.
  const { uuid, scriptName } = useMemo(() => {
    const stem = file.relativePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    if (file.relativePath.includes("scripts-config/") && UUID_RE.test(stem)) {
      return { uuid: stem, scriptName: null };
    }
    if (file.relativePath.includes("scripts-content/")) {
      // Try sibling config files first (only present when includeMetadata=true)
      for (const f of groupFiles) {
        if (!f.relativePath.includes("scripts-config/")) continue;
        const cfgStem = f.relativePath.split("/").pop()?.replace(/\.json$/, "") ?? "";
        if (!UUID_RE.test(cfgStem)) continue;
        try {
          const json = JSON.parse(f.localContent ?? f.remoteContent ?? "");
          if (json.name === stem) return { uuid: cfgStem, scriptName: null };
        } catch { /* skip */ }
      }
      // Fall back to name-based lookup (API will resolve UUID from scripts-config)
      return { uuid: null, scriptName: stem };
    }
    return { uuid: null, scriptName: null };
  }, [file.relativePath, groupFiles]);

  const fetchUsage = useCallback(async () => {
    if (usageData !== null) return;
    setUsageLoading(true);
    try {
      const envs = [...new Set([sourceEnv, targetEnv].filter(Boolean))];
      const results = await Promise.all(
        envs.map((env) => {
          const params = new URLSearchParams({ env });
          if (uuid) params.set("scriptId", uuid);
          else if (scriptName) params.set("scriptName", scriptName);
          else return Promise.resolve([] as ScriptUsageRef[]);
          return fetch(`/api/analyze/script-usage?${params}`)
            .then((r) => r.json())
            .then((d) => (d.usedBy ?? []).map((u: Omit<ScriptUsageRef, "env">) => ({ ...u, env })))
            .catch(() => [] as ScriptUsageRef[]);
        })
      );
      const seen = new Set<string>();
      const merged: ScriptUsageRef[] = [];
      for (const ref of results.flat()) {
        const key = `${ref.journey}::${ref.nodeUuid}`;
        if (!seen.has(key)) { seen.add(key); merged.push(ref); }
      }
      setUsageData(merged);
    } finally {
      setUsageLoading(false);
    }
  }, [uuid, scriptName, sourceEnv, targetEnv, usageData]);

  const handleFindUsage = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !usageOpen;
    setUsageOpen(next);
    if (next) fetchUsage();
  }, [usageOpen, fetchUsage]);

  const findUsageButton = (
    <button
      type="button"
      onClick={handleFindUsage}
      className={cn(
        "px-1.5 py-0.5 text-[10px] font-medium rounded border transition-colors",
        usageOpen
          ? "bg-violet-100 text-violet-700 border-violet-200"
          : "text-slate-500 border-slate-300 hover:text-violet-600 hover:bg-violet-50 hover:border-violet-200"
      )}
    >
      Find Usage
    </button>
  );

  const graphJourneyFile = useMemo(
    () => graphTarget
      ? allFiles.find((f) => f.relativePath.endsWith(`/journeys/${graphTarget.journeyName}/${graphTarget.journeyName}.json`))
      : undefined,
    [allFiles, graphTarget],
  );

  return (
    <div>
      <FileRow file={file} sourceLabel={sourceLabel} targetLabel={targetLabel} extraActions={findUsageButton} checked={checked} onToggle={onToggle} fileTasks={fileTasks} onRemoveFromTask={onRemoveFromTask} />
      {usageOpen && (
        <div className="mx-1 mb-1 px-2.5 py-2 rounded bg-violet-50 border border-violet-100 text-xs">
          {usageLoading ? (
            <p className="text-slate-400">Searching…</p>
          ) : !usageData || usageData.length === 0 ? (
            <p className="text-slate-400 italic">Not used in any journey.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] text-violet-600 font-semibold uppercase tracking-wide mb-1">
                Used in {usageData.length} {usageData.length === 1 ? "place" : "places"}
              </p>
              {usageData.map((ref, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                  <button
                    type="button"
                    className="text-violet-700 font-medium hover:underline text-left"
                    onClick={() => setGraphTarget({ journeyName: ref.journey, nodeUuid: ref.nodeUuid })}
                  >
                    {ref.journey}
                  </button>
                  <span className="text-slate-400">→</span>
                  <span className="text-slate-600">{ref.nodeName}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{ref.nodeType}</span>
                  {ref.env && (
                    <span className="text-[9px] text-violet-500 bg-violet-100 px-1 rounded">{ref.env}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {graphTarget && (
        <JourneyDiffGraphModal
          journeyName={graphTarget.journeyName}
          localContent={graphJourneyFile?.localContent}
          remoteContent={graphJourneyFile?.remoteContent}
          nodeInfos={[]}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
          sourceEnv={sourceEnv}
          targetEnv={targetEnv}
          files={allFiles}
          initialFocusNodeId={graphTarget.nodeUuid}
          onClose={() => setGraphTarget(null)}
        />
      )}
    </div>
  );
}

// ── Workflow scope ────────────────────────────────────────────────────────────

/** Extract the workflow name from an iga-workflows file path. */
function workflowNameFromPath(relativePath: string): string | null {
  // iga/workflows/{name}/... or realms/x/iga/workflows/{name}/...
  const m = relativePath.match(/\/workflows\/([^/]+)\//);
  return m?.[1] ?? null;
}

function WorkflowGroupRow({
  workflowName,
  changedFiles,
  allFiles,
  sourceLabel,
  targetLabel,
  checked,
  onToggle,
}: {
  workflowName: string;
  changedFiles: FileDiff[];
  allFiles: FileDiff[];
  sourceLabel: string;
  targetLabel: string;
  checked?: boolean;
  onToggle?: () => void;
}) {
  const [graphOpen, setGraphOpen] = useState(false);

  const added    = changedFiles.filter((f) => f.status === "added").length;
  const removed  = changedFiles.filter((f) => f.status === "removed").length;
  const modified = changedFiles.filter((f) => f.status === "modified").length;

  const workflowDiffFiles = useMemo(
    () => allFiles.filter((f) => workflowNameFromPath(f.relativePath) === workflowName),
    [allFiles, workflowName],
  );

  return (
    <>
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-slate-50 border border-slate-200">
        {onToggle !== undefined && (
          <input
            type="checkbox"
            checked={!!checked}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 w-3.5 h-3.5 accent-sky-600"
          />
        )}
        {/* Workflow icon */}
        <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
        </svg>
        <span className="text-xs font-medium text-slate-700 flex-1 truncate">{workflowName}</span>
        {/* Diff badges */}
        <div className="flex items-center gap-1 text-[9px] font-mono shrink-0">
          {modified > 0 && <span className="px-1 py-0.5 rounded bg-amber-100 text-amber-700">{modified} modified</span>}
          {added    > 0 && <span className="px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">{added} added</span>}
          {removed  > 0 && <span className="px-1 py-0.5 rounded bg-red-100 text-red-700">{removed} removed</span>}
        </div>
        {/* Graph button */}
        <button
          type="button"
          title="View workflow graph"
          onClick={(e) => { e.stopPropagation(); setGraphOpen(true); }}
          className="shrink-0 p-1 rounded text-slate-400 hover:text-sky-500 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
          </svg>
        </button>
      </div>
      {/* Individual changed file rows */}
      {changedFiles.map((f) => (
        <FileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} />
      ))}
      {graphOpen && (
        <WorkflowDiffGraphModal
          workflowName={workflowName}
          workflowFiles={workflowDiffFiles}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
          onClose={() => setGraphOpen(false)}
        />
      )}
    </>
  );
}

// ── Per-scope section inside the global All Files modal ─────────────────────

function AllFilesModalScopeSection({
  group, sourceLabel, targetLabel, sourceEnv, targetEnv, allFiles, selectedPaths, onTogglePath,
}: {
  group: ScopeGroup;
  sourceLabel: string;
  targetLabel: string;
  sourceEnv?: string;
  targetEnv?: string;
  allFiles?: FileDiff[];
  selectedPaths?: Set<string>;
  onTogglePath?: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | "modified" | "added" | "removed" | "unchanged">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const filtered = filterFiles(
    group.files.filter((f) => statusFilter === "all" || f.status === statusFilter),
    search,
  );
  const totalVisible = filtered.length;

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-sm font-semibold text-slate-700 flex-1">{group.label}</span>
        <div className="flex items-center gap-2 text-[10px] font-mono shrink-0">
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{group.itemCount} total</span>
          {group.itemModified > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{group.itemModified} modified</span>}
          {group.itemAdded > 0    && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{group.itemAdded} added</span>}
          {group.itemRemoved > 0  && <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700">{group.itemRemoved} removed</span>}
          {group.itemUnchanged > 0 && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{group.itemUnchanged} unchanged</span>}
        </div>
        <span className="text-slate-400 text-xs shrink-0">{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div className="bg-white">
          <div className="px-3 pt-3 pb-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex rounded border border-slate-300 overflow-hidden text-[10px] shrink-0">
              {([
                { value: "all"       as const, label: `All (${group.files.length})` },
                { value: "modified"  as const, label: `Modified (${group.modified})` },
                { value: "added"     as const, label: `Added (${group.added})` },
                { value: "removed"   as const, label: `Removed (${group.removed})` },
                { value: "unchanged" as const, label: `Unchanged (${group.unchanged})` },
              ]).map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => { setStatusFilter(f.value); setPage(0); }}
                  className={cn(
                    "px-2 py-0.5 transition-colors",
                    statusFilter === f.value ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative flex-1">
              <input
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder={`Search ${group.label} files…`}
                className="w-full pl-7 pr-7 py-1 text-xs border border-slate-200 rounded bg-slate-50 text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-400 focus:bg-white"
              />
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
            </div>
          </div>

          <div className="p-3 pt-1 space-y-1.5">
            {totalVisible === 0 ? (
              <p className="text-xs text-slate-400 text-center py-2">
                {search ? `No files match "${search}".` : "No files match the selected filter."}
              </p>
            ) : (
              filtered.slice(page * pageSize, (page + 1) * pageSize).map((f) => {
                const isEsv = /^esvs\/(variables|secrets)\//.test(f.relativePath);
                if (group.scope === "scripts" && sourceEnv !== undefined && targetEnv !== undefined) {
                  return <ScriptScopeFileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} sourceEnv={sourceEnv} targetEnv={targetEnv} groupFiles={group.files} allFiles={allFiles ?? []} checked={selectedPaths?.has(f.relativePath)} onToggle={onTogglePath ? () => onTogglePath(f.relativePath) : undefined} />;
                }
                if (isEsv && sourceEnv !== undefined && targetEnv !== undefined) {
                  return <EsvScopeFileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} sourceEnv={sourceEnv} targetEnv={targetEnv} checked={selectedPaths?.has(f.relativePath)} onToggle={onTogglePath ? () => onTogglePath(f.relativePath) : undefined} />;
                }
                return <FileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} checked={selectedPaths?.has(f.relativePath)} onToggle={onTogglePath ? () => onTogglePath(f.relativePath) : undefined} />;
              })
            )}
          </div>

          {totalVisible > pageSize && (
            <Pagination
              page={page} total={totalVisible} pageSize={pageSize}
              onChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(0); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Global modal showing all files across all scopes ────────────────────────

function AllFilesModal({
  scopeGroups, sourceLabel, targetLabel, sourceEnv, targetEnv, allFiles, selectedPaths, onTogglePath, onClose,
}: {
  scopeGroups: ScopeGroup[];
  sourceLabel: string;
  targetLabel: string;
  sourceEnv?: string;
  targetEnv?: string;
  allFiles?: FileDiff[];
  selectedPaths?: Set<string>;
  onTogglePath?: (path: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const totalItemsInModal = scopeGroups.reduce((s, g) => s + g.itemCount, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden" style={{ width: "90vw", maxWidth: 1200, height: "90vh" }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-800 truncate">All Items</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{totalItemsInModal} item{totalItemsInModal !== 1 ? "s" : ""} · {scopeGroups.length} scope{scopeGroups.length !== 1 ? "s" : ""}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="text-slate-400 hover:text-slate-600 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scope groups */}
        <div className="flex-1 overflow-auto p-5 space-y-3">
          {scopeGroups.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">No files to display.</p>
          ) : (
            scopeGroups.map((group) => (
              <AllFilesModalScopeSection
                key={group.scope}
                group={group}
                sourceLabel={sourceLabel}
                targetLabel={targetLabel}
                sourceEnv={sourceEnv}
                targetEnv={targetEnv}
                allFiles={allFiles}
                selectedPaths={selectedPaths}
                onTogglePath={onTogglePath}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function TaskItemsDrawer({
  eligibleTasks, selectedPaths, onClose, onUnselect, onClearSelection, onAddSelectedToTask, onRemoveItemFromTask, onRemoveScopeFromTask, onRemoveBulkFromTask, onClearTask,
}: {
  eligibleTasks: PromotionTask[];
  selectedPaths: Set<string>;
  onClose: () => void;
  onUnselect: (path: string) => void;
  onClearSelection: () => void;
  onAddSelectedToTask: (task: PromotionTask) => void;
  onRemoveItemFromTask: (task: PromotionTask, path: string) => void;
  onRemoveScopeFromTask: (task: PromotionTask, scope: string) => void;
  onRemoveBulkFromTask: (task: PromotionTask, paths: string[]) => void;
  onClearTask: (task: PromotionTask) => void;
}) {
  const { confirm } = useDialog();
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(eligibleTasks[0]?.id ?? null);
  const [search, setSearch] = useState("");
  /** Per-task drawer row selections (keys: "<scope>/<itemId>" or bare "<scope>"). */
  const [drawerSelection, setDrawerSelection] = useState<Set<string>>(new Set());

  // Clear bulk selection + search whenever the viewed task changes.
  useEffect(() => {
    setDrawerSelection(new Set());
    setSearch("");
  }, [currentTaskId]);

  // If eligibleTasks changes (router.refresh) and the current task vanished,
  // fall back to the first.
  useEffect(() => {
    if (currentTaskId && !eligibleTasks.some((t) => t.id === currentTaskId)) {
      setCurrentTaskId(eligibleTasks[0]?.id ?? null);
    }
  }, [eligibleTasks, currentTaskId]);

  const currentTask = useMemo(
    () => eligibleTasks.find((t) => t.id === currentTaskId) ?? null,
    [eligibleTasks, currentTaskId],
  );

  const totalItemsInTask = currentTask
    ? currentTask.items.reduce((n, s) => n + (s.items === undefined ? 1 : s.items.length), 0)
    : 0;

  const filteredTaskSelections = useMemo(() => {
    if (!currentTask) return [] as ScopeSelection[];
    const q = search.toLowerCase().trim();
    if (!q) return currentTask.items;
    return currentTask.items
      .map((s) => {
        if (s.scope.toLowerCase().includes(q)) return s;
        if (s.items === undefined) return null;
        const matches = s.items.filter((i) => i.toLowerCase().includes(q));
        return matches.length ? { ...s, items: matches } : null;
      })
      .filter((s): s is ScopeSelection => s !== null);
  }, [currentTask, search]);

  // Split the compare-page selection by whether each path is already in the
  // currently-viewed task.
  const { selectedNotInTask, selectedInTaskCount } = useMemo(() => {
    if (!currentTask) return { selectedNotInTask: [...selectedPaths], selectedInTaskCount: 0 };
    const notInTask: string[] = [];
    let inTaskCount = 0;
    for (const p of selectedPaths) {
      if (fileInTask(p, currentTask)) inTaskCount++;
      else notInTask.push(p);
    }
    return { selectedNotInTask: notInTask, selectedInTaskCount: inTaskCount };
  }, [selectedPaths, currentTask]);

  // Group selected paths by scope for display (same render as task items).
  const groupedSelection = useMemo(() => {
    const byScope = new Map<string, string[]>();
    for (const p of selectedPaths) {
      const scope = extractScope(p);
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope)!.push(p);
    }
    return Array.from(byScope.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [selectedPaths]);

  const toggleRow = (key: string) => {
    setDrawerSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const clearDrawerSelection = () => setDrawerSelection(new Set());

  const handleBulkRemove = () => {
    if (!currentTask) return;
    onRemoveBulkFromTask(currentTask, [...drawerSelection]);
    clearDrawerSelection();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40" onClick={onClose}>
      <aside
        className="fixed right-0 top-0 h-full w-[min(640px,100vw)] bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="label-xs">MANAGE ITEMS</div>
            <div className="text-base font-semibold text-slate-900 mt-0.5">Selection &amp; tasks</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-700 text-lg leading-none -mt-1 -mr-1"
          >
            ×
          </button>
        </div>

        {/* ── Selected items (task-agnostic) ─────────────────────────────── */}
        <div className="border-b border-slate-200">
          <div className="px-5 pt-4 pb-2 flex items-center justify-between">
            <div>
              <div className="label-xs">SELECTED ITEMS</div>
              <div className="text-[11px] text-slate-500">
                {selectedPaths.size === 0
                  ? "No items selected on the compare page."
                  : `${selectedPaths.size} item${selectedPaths.size === 1 ? "" : "s"} selected — not yet added to any task.`}
              </div>
            </div>
            {selectedPaths.size > 0 && (
              <button
                type="button"
                onClick={onClearSelection}
                className="text-[11px] text-slate-400 hover:text-slate-700"
              >
                Clear selection
              </button>
            )}
          </div>
          {selectedPaths.size > 0 && (
            <div className="max-h-48 overflow-y-auto px-5 pb-3 space-y-2">
              {groupedSelection.map(([scope, paths]) => (
                <div key={scope} className="border border-slate-200 rounded-md overflow-hidden">
                  <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 text-[11px] font-semibold text-slate-700">
                    {SCOPE_LABELS[scope] ?? scope}
                    <span className="ml-1.5 text-slate-400 font-normal">{paths.length}</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {paths.map((p) => {
                      const { itemId } = pathToTaskScopeAndItem(p);
                      return (
                        <div key={p} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                          <span className="flex-1 font-mono text-slate-700 truncate" title={p}>
                            {itemId ?? p}
                          </span>
                          <button
                            type="button"
                            onClick={() => onUnselect(p)}
                            className="text-slate-400 hover:text-rose-600 leading-none text-[13px]"
                            title="Unselect"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Task picker ──────────────────────────────────────────────── */}
        {eligibleTasks.length === 0 ? (
          <div className="flex-1 flex items-center justify-center px-5">
            <p className="text-xs text-slate-400 italic text-center">
              No promotion tasks match this compare direction.
            </p>
          </div>
        ) : (
          <>
            <div className="px-5 pt-4 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="label-xs shrink-0">TASK</span>
                <select
                  value={currentTaskId ?? ""}
                  onChange={(e) => setCurrentTaskId(e.target.value || null)}
                  className="flex-1 px-2 py-1 text-xs rounded border border-slate-200 bg-white text-slate-700 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
                >
                  {eligibleTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {t.items.reduce((n, s) => n + (s.items === undefined ? 1 : s.items.length), 0)} items
                    </option>
                  ))}
                </select>
              </div>
              {currentTask && (
                <div className="mt-2 text-[11px] text-slate-500 font-mono">
                  {currentTask.source.environment} → {currentTask.target.environment}
                  <span className="text-slate-400"> · {totalItemsInTask} item{totalItemsInTask === 1 ? "" : "s"}</span>
                  {selectedInTaskCount > 0 && (
                    <span className="ml-2 text-indigo-600">
                      ({selectedInTaskCount} of selection already in this task)
                    </span>
                  )}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter task items…"
                  className="flex-1 px-2 py-1 text-xs border border-slate-200 rounded bg-slate-50 text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 focus:bg-white"
                />
                {currentTask && selectedNotInTask.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onAddSelectedToTask(currentTask)}
                    className="px-2.5 py-1 text-[11px] font-medium rounded border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 transition-colors shrink-0"
                  >
                    + Add {selectedNotInTask.length} selected to task
                  </button>
                )}
              </div>
            </div>

            {/* ── Added items in current task ───────────────────────── */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
              {!currentTask ? null : filteredTaskSelections.length === 0 ? (
                <p className="text-center text-xs text-slate-400 py-6">
                  {search ? "No matches." : "This task has no items yet."}
                </p>
              ) : (
                filteredTaskSelections.map((sel) => (
                  <div key={sel.scope} className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-100">
                      <span className="text-xs font-semibold text-slate-700">
                        {SCOPE_LABELS[sel.scope] ?? sel.scope}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-400">
                          {sel.items === undefined ? "all items" : `${sel.items.length} item${sel.items.length === 1 ? "" : "s"}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemoveScopeFromTask(currentTask, sel.scope)}
                          className="text-[10px] text-rose-600 hover:text-rose-700 font-medium"
                        >
                          Remove scope
                        </button>
                      </div>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {sel.items === undefined ? (
                        <label className="flex items-center gap-2 px-3 py-2 text-[11px] cursor-pointer hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={drawerSelection.has(sel.scope)}
                            onChange={() => toggleRow(sel.scope)}
                            className="accent-indigo-600 w-3 h-3"
                          />
                          <span className="flex-1 text-slate-500 italic">
                            Whole-scope selection — all items promoted
                          </span>
                        </label>
                      ) : (
                        sel.items.map((itemId) => {
                          const rowKey = `${sel.scope}/${itemId}`;
                          return (
                            <label key={itemId} className="flex items-center gap-2 px-3 py-1.5 text-[11px] cursor-pointer hover:bg-slate-50">
                              <input
                                type="checkbox"
                                checked={drawerSelection.has(rowKey)}
                                onChange={() => toggleRow(rowKey)}
                                className="accent-indigo-600 w-3 h-3"
                              />
                              <span className="flex-1 font-mono text-slate-700 truncate" title={itemId}>{itemId}</span>
                              <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); onRemoveItemFromTask(currentTask, rowKey); }}
                                className="text-rose-500 hover:text-rose-700 leading-none text-[13px]"
                                title="Remove item"
                              >
                                ×
                              </button>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-2">
          {drawerSelection.size > 0 && currentTask ? (
            <>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">{drawerSelection.size} selected</span>
                <button
                  type="button"
                  onClick={clearDrawerSelection}
                  className="text-xs text-slate-400 hover:text-slate-700"
                >
                  Clear
                </button>
              </div>
              <button
                type="button"
                onClick={handleBulkRemove}
                className="px-3 py-1 text-xs font-medium rounded bg-rose-600 text-white hover:bg-rose-700 transition-colors"
              >
                Remove {drawerSelection.size} from task
              </button>
            </>
          ) : (
            <>
              {currentTask ? (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Clear task",
                      message: `Clear all items from "${currentTask.name}"?`,
                      confirmLabel: "Clear",
                      variant: "warning",
                    });
                    if (ok) onClearTask(currentTask);
                  }}
                  disabled={totalItemsInTask === 0}
                  className="text-xs text-rose-600 hover:text-rose-700 disabled:opacity-40 font-medium"
                >
                  Clear all items
                </button>
              ) : <span />}
              <button
                type="button"
                onClick={onClose}
                className="btn-secondary text-xs py-1"
              >
                Close
              </button>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function ScopeSection({
  group, sourceLabel, targetLabel, forceOpen, forceSeq, sourceEnv, targetEnv, allFiles, selectedPaths, onTogglePath, hideUnchanged = true, hideMetadata = true, eligibleTasks = [], onRemoveFromTask,
}: {
  group: ScopeGroup;
  sourceLabel: string;
  targetLabel: string;
  forceOpen?: boolean;
  forceSeq?: number;
  sourceEnv?: string;
  targetEnv?: string;
  allFiles?: FileDiff[];
  selectedPaths?: Set<string>;
  onTogglePath?: (path: string) => void;
  hideUnchanged?: boolean;
  hideMetadata?: boolean;
  eligibleTasks?: PromotionTask[];
  onRemoveFromTask?: (task: PromotionTask, path: string) => void;
}) {
  const supportsTypeFilter = group.scope === "scripts";
  const hasChanges = group.itemAdded > 0 || group.itemModified > 0 || group.itemRemoved > 0;
  const [open, setOpen] = useState(forceOpen ?? false);
  const [itemSearch, setItemSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "modified" | "added" | "removed">("all");
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);

  // React to parent expand/collapse all
  const prevSeq = useRef(forceSeq);
  if (forceSeq !== undefined && forceSeq !== prevSeq.current) {
    prevSeq.current = forceSeq;
    if (forceOpen !== undefined) setOpen(forceOpen);
  }

  // Close the type menu on outside click
  useEffect(() => {
    if (!typeMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (typeMenuRef.current && !typeMenuRef.current.contains(e.target as Node)) setTypeMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [typeMenuOpen]);

  const totalLines = group.files.reduce((s, f) => s + (f.linesAdded ?? 0) + (f.linesRemoved ?? 0), 0);

  // Available types for scripts scope, computed from the current group.files
  // (post metadata/unchanged filtering on the fly so the list matches what the
  // user could actually select).
  const availableTypes = useMemo(() => {
    if (!supportsTypeFilter) return [] as { key: string; label: string; count: number }[];
    const counts = new Map<string, number>();
    for (const f of group.files) {
      if (hideUnchanged && f.status === "unchanged") continue;
      if (hideMetadata && isMetadataFile(f, group.scope)) continue;
      const key = subgroupKeyForFile(f, group.scope);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({ key, label: humanizeSubgroup(group.scope, key), count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [group.files, group.scope, supportsTypeFilter, hideUnchanged, hideMetadata]);

  const visibleFiles = filterFiles(
    group.files.filter((f) => {
      if (hideUnchanged && f.status === "unchanged") return false;
      if (hideMetadata && isMetadataFile(f, group.scope)) return false;
      if (statusFilter !== "all" && f.status !== statusFilter) return false;
      if (supportsTypeFilter && typeFilter.size > 0) {
        const key = subgroupKeyForFile(f, group.scope);
        if (!key || !typeFilter.has(key)) return false;
      }
      return true;
    }),
    itemSearch,
  );
  const totalVisible = visibleFiles.length;
  const totalChanged = group.modified + group.added + group.removed;

  const toggleType = (key: string) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setPage(0);
  };
  const clearTypes = () => { setTypeFilter(new Set()); setPage(0); };

  return (
    <div className={cn("border rounded-lg overflow-hidden", hasChanges ? "border-slate-200" : "border-slate-100")}>
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-2.5 transition-colors",
          hasChanges ? "bg-slate-50 cursor-pointer hover:bg-slate-100" : "bg-slate-50/50 cursor-pointer hover:bg-slate-100/60",
        )}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cn("text-sm font-semibold flex-1", hasChanges ? "text-slate-700" : "text-slate-400")}>{group.label}</span>

        <div className="flex items-center gap-2 text-[10px] font-mono shrink-0">
          {group.itemModified > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{group.itemModified} modified</span>
          )}
          {group.itemAdded > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{group.itemAdded} added</span>
          )}
          {group.itemRemoved > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700">{group.itemRemoved} removed</span>
          )}
          {!hasChanges && (
            <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">no differences</span>
          )}
          {totalLines > 0 && (
            <span className="text-slate-400">({totalLines} lines)</span>
          )}
        </div>

        <span className="text-slate-400 text-xs shrink-0">{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div className="bg-white">
          {/* Filter + search bar */}
          {(hasChanges || !hideUnchanged) && (
            <div className="px-3 pt-3 pb-2 space-y-2" onClick={(e) => e.stopPropagation()}>
              {/* Row 1: status pills + optional type filter */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Status filter pills */}
                <div className="flex rounded border border-slate-300 overflow-hidden text-[10px] shrink-0">
                  {([
                    { value: "all"      as const, label: `All (${hideUnchanged ? totalChanged : group.files.length})` },
                    { value: "modified" as const, label: `Modified (${group.modified})` },
                    { value: "added"    as const, label: `Added (${group.added})` },
                    { value: "removed"  as const, label: `Removed (${group.removed})` },
                  ]).map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      onClick={() => { setStatusFilter(f.value); setPage(0); }}
                      className={cn(
                        "px-2 py-0.5 transition-colors",
                        statusFilter === f.value
                          ? "bg-slate-900 text-white"
                          : "bg-white text-slate-500 hover:bg-slate-50"
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {/* Type filter (scripts only) */}
                {supportsTypeFilter && availableTypes.length > 0 && (
                  <div className="relative" ref={typeMenuRef}>
                    <button
                      type="button"
                      onClick={() => setTypeMenuOpen((o) => !o)}
                      className={cn(
                        "flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border transition-colors",
                        typeFilter.size > 0
                          ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                          : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      <span>Type{typeFilter.size > 0 ? ` (${typeFilter.size})` : ""}</span>
                      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {typeMenuOpen && (
                      <div className="absolute left-0 top-full mt-1 z-10 w-64 max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-md shadow-lg py-1">
                        {availableTypes.map((t) => {
                          const checked = typeFilter.has(t.key);
                          return (
                            <label
                              key={t.key}
                              className="flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-slate-50 cursor-pointer select-none"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleType(t.key)}
                                className="accent-indigo-600 w-3 h-3"
                              />
                              <span className="flex-1 text-slate-700 truncate">{t.label}</span>
                              <span className="text-[10px] text-slate-400 font-mono shrink-0">{t.count}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Clear button (only when type filter active) */}
                {supportsTypeFilter && typeFilter.size > 0 && (
                  <button
                    type="button"
                    onClick={clearTypes}
                    className="px-2 py-0.5 text-[10px] rounded border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Row 2: search bar (full width) */}
              <div className="relative">
                <input
                  ref={searchRef}
                  type="text"
                  value={itemSearch}
                  onChange={(e) => { setItemSearch(e.target.value); setPage(0); }}
                  placeholder={`Search ${group.label} items…`}
                  className="w-full pl-7 pr-7 py-1 text-xs border border-slate-200 rounded bg-slate-50 text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-400 focus:bg-white"
                />
                <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                </svg>
                {itemSearch && (
                  <button
                    type="button"
                    onClick={() => setItemSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-[10px]"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="p-3 pt-1 space-y-1.5">
            {(hasChanges || !hideUnchanged) ? (
              totalVisible === 0 ? (
                <p className="text-xs text-slate-400 text-center py-2">
                  {itemSearch ? `No items match "${itemSearch}".` : "No items match the selected filter."}
                </p>
              ) : group.scope === "iga" ? (
                // Group workflow files by workflow name, show one row per workflow
                (() => {
                  const grouped = new Map<string, FileDiff[]>();
                  for (const f of visibleFiles.slice(page * pageSize, (page + 1) * pageSize)) {
                    const name = workflowNameFromPath(f.relativePath) ?? f.relativePath;
                    if (!grouped.has(name)) grouped.set(name, []);
                    grouped.get(name)!.push(f);
                  }
                  return Array.from(grouped.entries()).map(([name, files]) => (
                    <WorkflowGroupRow
                      key={name}
                      workflowName={name}
                      changedFiles={files}
                      allFiles={allFiles ?? []}
                      sourceLabel={sourceLabel}
                      targetLabel={targetLabel}
                      checked={selectedPaths?.has(`${group.scope}/${name}`)}
                      onToggle={onTogglePath ? () => onTogglePath(`${group.scope}/${name}`) : undefined}
                    />
                  ));
                })()
              ) : (
                visibleFiles.slice(page * pageSize, (page + 1) * pageSize).map((f) => {
                  const fileTasks = eligibleTasks.filter((t) => fileInTask(f.relativePath, t));
                  const isEsv = /^esvs\/(variables|secrets)\//.test(f.relativePath);
                  if (group.scope === "scripts" && sourceEnv !== undefined && targetEnv !== undefined) {
                    return <ScriptScopeFileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} sourceEnv={sourceEnv} targetEnv={targetEnv} groupFiles={group.files} allFiles={allFiles ?? []} checked={selectedPaths?.has(f.relativePath)} onToggle={onTogglePath ? () => onTogglePath(f.relativePath) : undefined} fileTasks={fileTasks} onRemoveFromTask={onRemoveFromTask} />;
                  }
                  if (isEsv && sourceEnv !== undefined && targetEnv !== undefined) {
                    return <EsvScopeFileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} sourceEnv={sourceEnv} targetEnv={targetEnv} checked={selectedPaths?.has(f.relativePath)} onToggle={onTogglePath ? () => onTogglePath(f.relativePath) : undefined} fileTasks={fileTasks} onRemoveFromTask={onRemoveFromTask} />;
                  }
                  return <FileRow key={f.relativePath} file={f} sourceLabel={sourceLabel} targetLabel={targetLabel} checked={selectedPaths?.has(f.relativePath)} onToggle={onTogglePath ? () => onTogglePath(f.relativePath) : undefined} fileTasks={fileTasks} onRemoveFromTask={onRemoveFromTask} />;
                })
              )
            ) : (
              <p className="text-xs text-slate-400 text-center py-2">
                {group.unchanged} file{group.unchanged !== 1 ? "s" : ""} compared — no differences found.
              </p>
            )}
          </div>
          {(hasChanges || !hideUnchanged) && totalVisible > pageSize && (
            <Pagination
              page={page} total={totalVisible} pageSize={pageSize}
              onChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Main report ─────────────────────────────────────────────────────────────

export function DiffReport({ report, tasks = [], mode = "compare", dryRunMode, showUnchangedByDefault = false }: { report: CompareReport; tasks?: PromotionTask[]; mode?: DiffMode; dryRunMode?: boolean; showUnchangedByDefault?: boolean }) {
  // Back-compat: the older `dryRunMode` boolean still works — it maps to mode="dry-run".
  const effectiveMode: DiffMode = dryRunMode ? "dry-run" : mode;
  const { summary, files } = report;
  const [hideUnchanged, setHideUnchanged] = useState(!showUnchangedByDefault);
  const [hideMetadata, setHideMetadata] = useState(true);
  const [allOpen, setAllOpen] = useState<boolean | undefined>(undefined);
  const [allOpenSeq, setAllOpenSeq] = useState(0);
  const [allFilesModalOpen, setAllFilesModalOpen] = useState(false);

  const router = useRouter();
  const [scopeSearch, setScopeSearch] = useState("");
  const [onlyUsedEsvs, setOnlyUsedEsvs] = useState(true);
  const [esvMode, setEsvMode] = useEsvDisplayMode();
  const [usedEsvs, setUsedEsvs] = useState<Set<string> | null>(null);
  const [usedEsvsLoading, setUsedEsvsLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [addingToTask, setAddingToTask] = useState(false);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [addError, setAddError] = useState<{ task: string; missing: string[] } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [taskDropdownOpen, setTaskDropdownOpen] = useState(false);

  // Match tasks that are still editable — not archived and not terminal —
  // and whose source and target envs align with the comparison.
  // Completed/failed tasks represent finalized runs; adding items to them
  // would silently reset their status, so exclude them.
  const eligibleTasks = tasks.filter(
    (t) =>
      !t.archivedAt &&
      t.status !== "completed" &&
      t.status !== "failed" &&
      t.source.environment === report.source.environment &&
      t.target.environment === report.target.environment,
  );

  const sameEnv = report.source.environment === report.target.environment;
  const sourceLabel = sameEnv
    ? `${report.source.environment} (${report.source.mode})`
    : report.source.environment;
  const targetLabel = sameEnv
    ? `${report.target.environment} (${report.target.mode})`
    : report.target.environment;

  // Fetch the set of referenced ESV names from the source env when the
  // "only used" toggle is enabled. Cached per-env in this component.
  useEffect(() => {
    if (!onlyUsedEsvs) return;
    if (usedEsvs) return; // already loaded
    const envName = report.source.environment;
    if (!envName) return;
    const ctl = new AbortController();
    setUsedEsvsLoading(true);
    fetch(`/api/analyze/esv-used?env=${encodeURIComponent(envName)}`, { signal: ctl.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => setUsedEsvs(new Set<string>(data.names ?? [])))
      .catch(() => { /* leave unset; filter will no-op */ })
      .finally(() => setUsedEsvsLoading(false));
    return () => ctl.abort();
  }, [onlyUsedEsvs, usedEsvs, report.source.environment]);

  /** Normalize an ESV filename (esv-foo.variable.json / esv-foo.secret.json / esv-foo.json) to the canonical key. */
  const esvNameFromFilename = useCallback((filename: string): string | null => {
    const base = filename
      .replace(/\.variable\.json$/i, "")
      .replace(/\.secret\.json$/i, "")
      .replace(/\.json$/i, "");
    let n = base.toLowerCase();
    if (n.startsWith("esv-")) n = n.slice(4);
    else if (n.startsWith("esv.")) n = n.slice(4);
    n = n.replace(/\./g, "-");
    return n || null;
  }, []);

  // Apply the onlyUsedEsvs filter to the report files before grouping.
  const filteredFiles = useMemo(() => {
    if (!onlyUsedEsvs || !usedEsvs) return files;
    return files.filter((f) => {
      const m = f.relativePath.match(/^esvs\/(variables|secrets)\/(.+)$/);
      if (!m) return true; // non-ESV files pass through
      const filename = m[2].split("/").pop() ?? "";
      const name = esvNameFromFilename(filename);
      return name ? usedEsvs.has(name) : true;
    });
  }, [files, onlyUsedEsvs, usedEsvs, esvNameFromFilename]);

  const scopeGroups = useMemo(() => groupByScope(filteredFiles), [filteredFiles]);
  // Non-journey scope groups — journeys are shown via the JourneyTreeSection
  const nonJourneyScopeGroups = useMemo(
    () => scopeGroups.filter((g) => g.scope !== "journeys"),
    [scopeGroups],
  );
  // Apply the scope-search filter to the non-journey groups. Match against the
  // raw scope id and the human label, so 'iga' or 'IGA Workflow' both work.
  const visibleScopeGroups = useMemo(() => {
    const q = scopeSearch.trim().toLowerCase();
    if (!q) return nonJourneyScopeGroups;
    return nonJourneyScopeGroups.filter((g) =>
      g.scope.toLowerCase().includes(q) ||
      formatScopeLabel(g.scope).toLowerCase().includes(q)
    );
  }, [nonJourneyScopeGroups, scopeSearch]);
  const journeysVisible = useMemo(() => {
    const q = scopeSearch.trim().toLowerCase();
    if (!q) return true;
    return "journeys".includes(q) || formatScopeLabel("journeys").toLowerCase().includes(q);
  }, [scopeSearch]);

  // Item-level summary totals (deduped for dir-based scopes)
  const itemSummary = useMemo(() => {
    const s = { added: 0, modified: 0, removed: 0, unchanged: 0 };
    for (const g of scopeGroups) {
      s.added += g.itemAdded;
      s.modified += g.itemModified;
      s.removed += g.itemRemoved;
      s.unchanged += g.itemUnchanged;
    }
    return s;
  }, [scopeGroups]);
  const totalItems = itemSummary.added + itemSummary.removed + itemSummary.modified + itemSummary.unchanged;
  const changedCount = itemSummary.added + itemSummary.removed + itemSummary.modified;

  const togglePath = (path: string) =>
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  /** Find selected paths whose content exists only on the compare target side
   *  (status "added" from source → target == absent on source). When the task
   *  source matches the compare source, these items can't be promoted because
   *  there's nothing on source to push.
   */
  const findMissingOnSource = (paths: Set<string>, files: FileDiff[]): string[] => {
    const missing: string[] = [];
    for (const p of paths) {
      // Journey-style path: journeys/<name>
      if (p.startsWith("journeys/") && !p.includes(".")) {
        const name = p.slice("journeys/".length);
        const mainFile = files.find((f) =>
          f.relativePath.endsWith(`/journeys/${name}/${name}.json`) ||
          f.relativePath.endsWith(`journeys/${name}/${name}.json`)
        );
        if (mainFile && mainFile.status === "added") missing.push(p);
        continue;
      }
      // iga-workflows-style path: iga-workflows/<name>
      if (p.startsWith("iga-workflows/") && !p.includes(".")) {
        const name = p.slice("iga-workflows/".length);
        const anyFile = files.find((f) => workflowNameFromPath(f.relativePath) === name);
        if (anyFile && anyFile.status === "added") missing.push(p);
        continue;
      }
      // Plain file path
      const file = files.find((f) => f.relativePath === p);
      if (file && file.status === "added") missing.push(p);
    }
    return missing;
  };

  const handleRemoveFromTask = async (task: PromotionTask, pathOrItems: string | ScopeSelection[]) => {
    const newItems = Array.isArray(pathOrItems)
      ? pathOrItems
      : removeItemFromTaskItems(pathOrItems, task.items);
    try {
      const res = await fetch(`/api/promotion-tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...task, items: newItems }),
      });
      if (res.ok) router.refresh();
    } catch {
      // swallow — router.refresh() will not fire and UI stays in sync
    }
  };

  const handleAddToTask = async (task: PromotionTask) => {
    setTaskDropdownOpen(false);
    setAddError(null);

    // Validate that every selected item exists on the task's source. When the
    // task and compare share a source env, any file with status "added" is
    // present only on target and therefore missing on source.
    if (task.source.environment === report.source.environment) {
      const missing = findMissingOnSource(selectedPaths, report.files);
      if (missing.length > 0) {
        setAddError({ task: task.name, missing });
        return;
      }
    }

    setAddingToTask(true);
    const newItems = mergePathsIntoItems(selectedPaths, task.items);
    try {
      const res = await fetch(`/api/promotion-tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...task, items: newItems }),
      });
      if (res.ok) {
        setAddSuccess(task.name);
        setSelectedPaths(new Set());
        router.refresh(); // invalidate router cache so Promote page gets fresh task data
        setTimeout(() => setAddSuccess(null), 3000);
      }
    } finally {
      setAddingToTask(false);
    }
  };

  const selectedCount = selectedPaths.size;
  const selectedScopeCount = new Set([...selectedPaths].map((p) => extractScope(p))).size;

  useEffect(() => {
    if (!taskDropdownOpen) return;
    const handler = () => setTaskDropdownOpen(false);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [taskDropdownOpen]);

  return (
    <DiffModeContext.Provider value={effectiveMode}>
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">
            <span className="font-mono">{sourceLabel}</span>
            <span className="mx-1.5 text-slate-400">→</span>
            <span className="font-mono">{targetLabel}</span>
          </h2>
          <span className="text-xs text-slate-400">{new Date(report.generatedAt).toLocaleString()}</span>
        </div>

        {/* Stats cards */}
        <div className="flex flex-wrap gap-3">
          <Stat count={itemSummary.modified}  label="Modified"  color="text-amber-700"   bg="bg-amber-50" />
          <Stat count={itemSummary.added}     label="Added"     color="text-emerald-700" bg="bg-emerald-50" />
          <Stat count={itemSummary.removed}   label="Removed"   color="text-rose-700"    bg="bg-rose-50" />
          <Stat count={itemSummary.unchanged} label="Unchanged" color="text-slate-500"   bg="bg-slate-50" />
          <div className="ml-auto flex items-center gap-3 self-center">
            <span className="text-xs text-slate-400">
              {totalItems} item{totalItems !== 1 ? "s" : ""} · {scopeGroups.length} scope{scopeGroups.length !== 1 ? "s" : ""}
            </span>
            <button
              type="button"
              onClick={() => setAllFilesModalOpen(true)}
              className="px-2.5 py-1 text-xs font-medium rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-100 hover:border-slate-400 transition-colors"
            >
              View all
            </button>
          </div>
        </div>

        {/* Filters (always visible) */}
        <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-100 mt-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideUnchanged}
              onChange={(e) => setHideUnchanged(e.target.checked)}
              className="accent-sky-600"
            />
            Hide unchanged files
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideMetadata}
              onChange={(e) => setHideMetadata(e.target.checked)}
              className="accent-sky-600"
            />
            Hide metadata files
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none" title="Filter ESV variables/secrets to those actually referenced in the source environment">
            <input
              type="checkbox"
              checked={onlyUsedEsvs}
              onChange={(e) => setOnlyUsedEsvs(e.target.checked)}
              className="accent-sky-600"
            />
            Only used ESVs
            {usedEsvsLoading && <span className="text-[10px] text-slate-400">loading…</span>}
          </label>

          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <span>ESV values:</span>
            <EsvDisplayToggle mode={esvMode} onChange={setEsvMode} />
          </div>

          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              value={scopeSearch}
              onChange={(e) => setScopeSearch(e.target.value)}
              placeholder="Filter scopes…"
              className="text-xs px-2 py-1 rounded border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 w-44"
            />
            {scopeSearch && (
              <button
                type="button"
                onClick={() => setScopeSearch("")}
                className="text-slate-400 hover:text-slate-600 text-xs"
                title="Clear scope filter"
              >
                ✕
              </button>
            )}
          </div>

        </div>
      </div>

      {/* Scope sections */}
      <div className="p-5 space-y-3">
        {changedCount === 0 && itemSummary.unchanged === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">
            No files to display.
          </p>
        ) : (
          <>
            {/* Journey tree (shown first if available) — only when journeys
                was an actually-selected scope for this compare run. If the
                user didn't include journeys in their scope selection, suppress
                the tree even if the backend populated it. */}
            {journeysVisible && report.journeyTree && report.journeyTree.length > 0 && scopeGroups.some((g) => g.scope === "journeys") && (
              <JourneyTreeSection tree={report.journeyTree} forceOpen={allOpen} forceSeq={allOpenSeq} files={files} sourceLabel={sourceLabel} targetLabel={targetLabel} sourceEnv={report.source.environment} targetEnv={report.target.environment} selectedPaths={selectedPaths} onTogglePath={togglePath} hideUnchanged={hideUnchanged} />
            )}

            {/* Non-journey scope sections (journeys are shown above in the tree) */}
            {visibleScopeGroups.length === 0 && scopeSearch && (
              <p className="text-sm text-slate-400 text-center py-4">No scopes match &ldquo;{scopeSearch}&rdquo;.</p>
            )}
            {visibleScopeGroups.map((group) => (
              <ScopeSection
                key={group.scope}
                group={group}
                sourceLabel={sourceLabel}
                targetLabel={targetLabel}
                forceOpen={allOpen}
                forceSeq={allOpenSeq}
                sourceEnv={report.source.environment}
                targetEnv={report.target.environment}
                allFiles={report.files}
                selectedPaths={selectedPaths}
                onTogglePath={togglePath}
                hideUnchanged={hideUnchanged}
                hideMetadata={hideMetadata}
                eligibleTasks={eligibleTasks}
                onRemoveFromTask={handleRemoveFromTask}
              />
            ))}
          </>
        )}
        {!hideUnchanged && itemSummary.unchanged > 0 && (
          <p className="text-xs text-slate-400 text-center pt-2">
            {itemSummary.unchanged} item{itemSummary.unchanged !== 1 ? "s" : ""} unchanged
          </p>
        )}
      </div>

      {allFilesModalOpen && (
        <AllFilesModal
          scopeGroups={scopeGroups}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
          sourceEnv={report.source.environment}
          targetEnv={report.target.environment}
          allFiles={report.files}
          selectedPaths={selectedPaths}
          onTogglePath={togglePath}
          onClose={() => setAllFilesModalOpen(false)}
        />
      )}

      {/* Task drawer */}
      {drawerOpen && (
        <TaskItemsDrawer
          eligibleTasks={eligibleTasks}
          selectedPaths={selectedPaths}
          onClose={() => setDrawerOpen(false)}
          onUnselect={(path) => togglePath(path)}
          onClearSelection={() => setSelectedPaths(new Set())}
          onAddSelectedToTask={(task) => handleAddToTask(task)}
          onRemoveItemFromTask={(task, path) => handleRemoveFromTask(task, path)}
          onRemoveScopeFromTask={(task, scope) => {
            const next = task.items.filter((s) => s.scope !== scope);
            handleRemoveFromTask(task, next);
          }}
          onRemoveBulkFromTask={(task, paths) => {
            let items = task.items;
            for (const p of paths) items = removeItemFromTaskItems(p, items);
            handleRemoveFromTask(task, items);
          }}
          onClearTask={(task) => handleRemoveFromTask(task, [])}
        />
      )}

      {/* Floating action bar */}
      {(selectedCount > 0 || addSuccess || addError) && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
          {addSuccess && (
            <div className="bg-emerald-600 text-white rounded-full shadow-lg px-4 py-2 text-xs font-medium whitespace-nowrap">
              ✓ Added to &quot;{addSuccess}&quot;
            </div>
          )}
          {addError && (
            <div className="bg-white border border-rose-200 rounded-xl shadow-xl px-4 py-3 text-xs text-slate-700 max-w-lg">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-rose-700 mb-1">
                    Can&apos;t add {addError.missing.length} item{addError.missing.length === 1 ? "" : "s"} to &quot;{addError.task}&quot;
                  </div>
                  <div className="text-slate-500 mb-2">
                    The following don&apos;t exist on the task&apos;s source ({report.source.environment}):
                  </div>
                  <ul className="font-mono text-[11px] text-slate-700 space-y-0.5 max-h-40 overflow-y-auto pr-2">
                    {addError.missing.map((p) => (
                      <li key={p} className="truncate" title={p}>• {p}</li>
                    ))}
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={() => setAddError(null)}
                  aria-label="Dismiss"
                  className="text-slate-400 hover:text-slate-600 shrink-0 -mt-0.5 -mr-1 text-lg leading-none"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {selectedCount > 0 && (
            <div className="bg-white border border-slate-200 rounded-full shadow-lg px-3 py-2 flex items-center gap-3 text-xs">
              <span className="text-slate-700 font-medium whitespace-nowrap">
                {selectedCount} item{selectedCount !== 1 ? "s" : ""} selected
                {selectedScopeCount > 1 && <span className="text-slate-400"> · {selectedScopeCount} scopes</span>}
              </span>

              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setTaskDropdownOpen((o) => !o); }}
                  disabled={addingToTask || eligibleTasks.length === 0}
                  className="flex items-center gap-1 px-3 py-1 bg-sky-600 text-white rounded-full text-xs font-medium hover:bg-sky-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {addingToTask ? "Adding…" : "Add to task"}
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {taskDropdownOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-full mb-1.5 left-0 bg-white border border-slate-200 rounded-lg shadow-xl min-w-[200px] py-1 z-50"
                  >
                    {eligibleTasks.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-slate-400 italic">No matching tasks</p>
                    ) : eligibleTasks.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => handleAddToTask(t)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors"
                      >
                        <span className="font-medium text-slate-700">{t.name}</span>
                        {t.items.length > 0 && (
                          <span className="ml-1.5 text-slate-400">({t.items.length} scope{t.items.length !== 1 ? "s" : ""})</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {eligibleTasks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors whitespace-nowrap"
                >
                  Manage items
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedPaths(new Set())}
                className="text-slate-400 hover:text-slate-600 transition-colors"
                title="Clear selection"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
    </DiffModeContext.Provider>
  );
}

function Stat({ count, label, color, bg }: { count: number; label: string; color: string; bg: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg", bg)}>
      <span className={cn("text-lg font-bold leading-none", color)}>{count}</span>
      <span className={cn("text-xs", color)}>{label}</span>
    </div>
  );
}
