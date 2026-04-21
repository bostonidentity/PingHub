"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileContentViewer } from "./FileContentViewer";

interface Props {
  content: string;
  fileName: string;
  highlightLine?: number;
}

// ── Row types ─────────────────────────────────────────────────────────────────

type TreeRow =
  | { kind: "open"; depth: number; path: string; keyLabel: string | null; bracket: "{" | "[" }
  | { kind: "close"; depth: number; path: string; bracket: "}" | "]"; trailingComma: boolean }
  | {
      kind: "leaf";
      depth: number;
      path: string;
      keyLabel: string | null;
      valueText: string;
      valueType: "string" | "number" | "boolean" | "null" | "empty";
      trailingComma: boolean;
    }
  | {
      kind: "collapsed";
      depth: number;
      path: string;
      keyLabel: string | null;
      container: "object" | "array";
      count: number;
      trailingComma: boolean;
    };

// ── Path helpers ──────────────────────────────────────────────────────────────

const ROOT = "$";

function pathJoin(parent: string, key: string): string {
  return parent === ROOT ? `${ROOT}.${key}` : `${parent}.${key}`;
}

function displayPath(path: string): string {
  if (path === ROOT) return "(root)";
  return path.replace(/^\$\./, "").replace(/^\$/, "");
}

function ancestorsOf(path: string): string[] {
  const out: string[] = [ROOT];
  if (path === ROOT) return out;
  const tail = path.replace(/^\$\.?/, "");
  const parts = tail.split(/(\[\d+\])|\./).filter(Boolean);
  let cur = ROOT;
  for (const p of parts) {
    cur = p.startsWith("[") ? `${cur}${p}` : pathJoin(cur, p);
    out.push(cur);
  }
  if (out[out.length - 1] === path) out.pop();
  return out;
}

// ── Pretty-print with line → path map ────────────────────────────────────────

function prettyWithPaths(value: unknown): { text: string; pathByLine: string[] } {
  const parts: string[] = [];
  const paths: string[] = [];
  let lineIdx = 0;
  const pad = (d: number) => "  ".repeat(d);

  const emit = (text: string, path: string) => {
    if (parts.length > 0) parts.push("\n");
    parts.push(text);
    paths[lineIdx++] = path;
  };

  const walk = (v: unknown, depth: number, path: string, prefix: string, suffix: string) => {
    if (v === null || typeof v !== "object") {
      emit(`${pad(depth)}${prefix}${JSON.stringify(v)}${suffix}`, path);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        emit(`${pad(depth)}${prefix}[]${suffix}`, path);
        return;
      }
      emit(`${pad(depth)}${prefix}[`, path);
      v.forEach((c, i) => walk(c, depth + 1, `${path}[${i}]`, "", i < v.length - 1 ? "," : ""));
      emit(`${pad(depth)}]${suffix}`, path);
      return;
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      emit(`${pad(depth)}${prefix}{}${suffix}`, path);
      return;
    }
    emit(`${pad(depth)}${prefix}{`, path);
    keys.forEach((k, i) =>
      walk(obj[k], depth + 1, pathJoin(path, k), `${JSON.stringify(k)}: `, i < keys.length - 1 ? "," : ""),
    );
    emit(`${pad(depth)}}${suffix}`, path);
  };

  walk(value, 0, ROOT, "", "");
  return { text: parts.join(""), pathByLine: paths };
}

// ── Tree row builder ──────────────────────────────────────────────────────────

function buildTreeRows(value: unknown, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (v: unknown, depth: number, path: string, keyLabel: string | null, trailingComma: boolean) => {
    const isExpanded = expanded.has(path);

    if (v === null) {
      rows.push({ kind: "leaf", depth, path, keyLabel, valueText: "null", valueType: "null", trailingComma });
      return;
    }
    if (typeof v === "string") {
      rows.push({ kind: "leaf", depth, path, keyLabel, valueText: JSON.stringify(v), valueType: "string", trailingComma });
      return;
    }
    if (typeof v === "number") {
      rows.push({ kind: "leaf", depth, path, keyLabel, valueText: String(v), valueType: "number", trailingComma });
      return;
    }
    if (typeof v === "boolean") {
      rows.push({ kind: "leaf", depth, path, keyLabel, valueText: String(v), valueType: "boolean", trailingComma });
      return;
    }
    if (typeof v !== "object") return;

    if (Array.isArray(v)) {
      if (v.length === 0) {
        rows.push({ kind: "leaf", depth, path, keyLabel, valueText: "[]", valueType: "empty", trailingComma });
        return;
      }
      if (!isExpanded) {
        rows.push({ kind: "collapsed", depth, path, keyLabel, container: "array", count: v.length, trailingComma });
        return;
      }
      rows.push({ kind: "open", depth, path, keyLabel, bracket: "[" });
      v.forEach((c, i) => walk(c, depth + 1, `${path}[${i}]`, null, i < v.length - 1));
      rows.push({ kind: "close", depth, path, bracket: "]", trailingComma });
      return;
    }

    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      rows.push({ kind: "leaf", depth, path, keyLabel, valueText: "{}", valueType: "empty", trailingComma });
      return;
    }
    if (!isExpanded) {
      rows.push({ kind: "collapsed", depth, path, keyLabel, container: "object", count: keys.length, trailingComma });
      return;
    }
    rows.push({ kind: "open", depth, path, keyLabel, bracket: "{" });
    keys.forEach((k, i) => walk(obj[k], depth + 1, pathJoin(path, k), k, i < keys.length - 1));
    rows.push({ kind: "close", depth, path, bracket: "}", trailingComma });
  };

  walk(value, 0, ROOT, null, false);
  return rows;
}

// Deepest depth at which the value is a non-empty container. -1 if the
// document has no expandable node (primitive root, empty object, etc).
function maxExpandableDepth(value: unknown): number {
  let max = -1;
  const walk = (v: unknown, d: number) => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      if (d > max) max = d;
      v.forEach((c) => walk(c, d + 1));
      return;
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return;
    if (d > max) max = d;
    keys.forEach((k) => walk(obj[k], d + 1));
  };
  walk(value, 0);
  return max;
}

// Return the expansion set that reveals `depth` levels of content. Depth=1
// shows the root's immediate keys; depth=2 also shows their children; etc.
function expandToDepth(value: unknown, depth: number): Set<string> {
  const out = new Set<string>();
  if (depth <= 0) return out;
  const walk = (v: unknown, d: number, path: string) => {
    if (v === null || typeof v !== "object") return;
    if (d >= depth) return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      out.add(path);
      v.forEach((c, i) => walk(c, d + 1, `${path}[${i}]`));
      return;
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return;
    out.add(path);
    keys.forEach((k) => walk(obj[k], d + 1, pathJoin(path, k)));
  };
  walk(value, 0, ROOT);
  return out;
}

function firstKeyPath(value: unknown, needle: string): string | null {
  const q = needle.toLowerCase();
  const walk = (v: unknown, path: string): string | null => {
    if (v === null || typeof v !== "object") return null;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const r = walk(v[i], `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    const obj = v as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const p = pathJoin(path, k);
      if (k.toLowerCase().includes(q)) return p;
      const r = walk(obj[k], p);
      if (r) return r;
    }
    return null;
  };
  return walk(value, ROOT);
}

function initialExpanded(value: unknown): Set<string> {
  const out = new Set<string>([ROOT]);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out.add(pathJoin(ROOT, k));
  }
  return out;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function JsonFileViewer({ content, fileName, highlightLine }: Props) {
  const parsed = useMemo<{ ok: true; value: unknown } | { ok: false; error: string }>(() => {
    try {
      return { ok: true, value: JSON.parse(content) as unknown };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [content]);

  const [mode, setMode] = useState<"tree" | "raw">(highlightLine ? "raw" : "tree");
  const [expanded, setExpanded] = useState<Set<string>>(() => (parsed.ok ? initialExpanded(parsed.value) : new Set([ROOT])));
  const [selectedPath, setSelectedPath] = useState<string>(ROOT);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [jumpKey, setJumpKey] = useState("");
  const [pathCopied, setPathCopied] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(192);
  const [fullscreen, setFullscreen] = useState(false);

  // Escape exits fullscreen. Registered only while active so we don't
  // swallow Escape in the (far more common) embedded mode.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const startSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      // Dragging leftward widens the sidebar.
      const next = Math.max(140, Math.min(640, startW + (startX - ev.clientX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // When a deep-link supplies a highlightLine, flip to raw mode as soon as
  // the prop arrives. Uses the "compare to previous prop during render" pattern
  // instead of an effect so we don't trigger an extra render cycle.
  const [prevHighlight, setPrevHighlight] = useState(highlightLine);
  if (prevHighlight !== highlightLine) {
    setPrevHighlight(highlightLine);
    if (highlightLine) setMode("raw");
  }

  const prettyRaw = useMemo(
    () => (parsed.ok ? prettyWithPaths(parsed.value) : { text: content, pathByLine: [] as string[] }),
    [parsed, content],
  );

  const treeRows = useMemo(() => (parsed.ok ? buildTreeRows(parsed.value, expanded) : []), [parsed, expanded]);

  const maxDepth = useMemo(() => (parsed.ok ? maxExpandableDepth(parsed.value) : -1), [parsed]);

  const toc = useMemo<{ label: string; path: string }[]>(() => {
    if (!parsed.ok) return [];
    const v = parsed.value;
    if (v === null || typeof v !== "object") return [];
    if (Array.isArray(v)) return v.map((_, i) => ({ label: `[${i}]`, path: `${ROOT}[${i}]` }));
    return Object.keys(v as Record<string, unknown>).map((k) => ({ label: k, path: pathJoin(ROOT, k) }));
  }, [parsed]);

  const matchesRaw = useMemo<number[]>(() => {
    if (!findQuery) return [];
    const q = findQuery.toLowerCase();
    const out: number[] = [];
    prettyRaw.text.split("\n").forEach((line, i) => {
      if (line.toLowerCase().includes(q)) out.push(i + 1);
    });
    return out;
  }, [findQuery, prettyRaw.text]);

  const matchesTree = useMemo<number[]>(() => {
    if (!findQuery) return [];
    const q = findQuery.toLowerCase();
    const out: number[] = [];
    treeRows.forEach((r, i) => {
      if (r.kind === "open") {
        if (r.keyLabel && r.keyLabel.toLowerCase().includes(q)) out.push(i);
      } else if (r.kind === "leaf") {
        if ((r.keyLabel && r.keyLabel.toLowerCase().includes(q)) || r.valueText.toLowerCase().includes(q)) out.push(i);
      } else if (r.kind === "collapsed") {
        if (r.keyLabel && r.keyLabel.toLowerCase().includes(q)) out.push(i);
      }
    });
    return out;
  }, [findQuery, treeRows]);

  const matches = mode === "tree" ? matchesTree : matchesRaw;

  // Reset the match index when the query text or view mode changes. Done with
  // the prop-comparison-during-render pattern so it doesn't cost an extra pass.
  const matchSig = `${mode}|${findQuery}`;
  const [prevMatchSig, setPrevMatchSig] = useState(matchSig);
  if (prevMatchSig !== matchSig) {
    setPrevMatchSig(matchSig);
    setFindIdx(0);
  }

  const clampedIdx = matches.length === 0 ? 0 : Math.min(findIdx, matches.length - 1);

  const contentScrollRef = useRef<HTMLDivElement>(null);

  // Scroll current tree match into view
  useEffect(() => {
    if (mode !== "tree" || matches.length === 0) return;
    const rowIdx = matches[clampedIdx];
    const el = contentScrollRef.current?.querySelector(`[data-row="${rowIdx}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
  }, [mode, matches, clampedIdx]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const applyLevel = useCallback(
    (n: number) => {
      if (!parsed.ok) return;
      setExpanded(expandToDepth(parsed.value, n));
    },
    [parsed],
  );

  const expandToPath = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestorsOf(path)) next.add(a);
      return next;
    });
  }, []);

  const scrollTreeToPath = useCallback((path: string) => {
    // Let React re-render with the new expansion before we query.
    setTimeout(() => {
      const nodes = contentScrollRef.current?.querySelectorAll(`[data-path="${cssEscape(path)}"]`);
      const el = nodes && nodes.length > 0 ? (nodes[0] as HTMLElement) : null;
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
  }, []);

  // Raw mode scroll — FileContentViewer virtualizes rows so we can't rely on
  // querySelector finding the target. Bump a request object instead; the
  // viewer reads it in an effect and asks the virtualizer to scroll.
  const [rawScrollRequest, setRawScrollRequest] = useState<{ line: number; nonce: number } | null>(null);
  const scrollRawToPath = useCallback((path: string) => {
    const ln = prettyRaw.pathByLine.findIndex((p) => p === path);
    if (ln < 0) return;
    setRawScrollRequest({ line: ln + 1, nonce: Date.now() });
  }, [prettyRaw.pathByLine]);

  const goToPath = useCallback(
    (path: string) => {
      setSelectedPath(path);
      if (mode === "tree") {
        expandToPath(path);
        scrollTreeToPath(path);
      } else {
        scrollRawToPath(path);
      }
    },
    [mode, expandToPath, scrollTreeToPath, scrollRawToPath],
  );

  const handleJumpKey = useCallback(() => {
    if (!jumpKey || !parsed.ok) return;
    const hit = firstKeyPath(parsed.value, jumpKey);
    if (hit) goToPath(hit);
  }, [jumpKey, parsed, goToPath]);

  const copyPath = useCallback(() => {
    navigator.clipboard.writeText(selectedPath).then(() => {
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    });
  }, [selectedPath]);

  const nextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setFindIdx((i) => (i + 1) % matches.length);
  }, [matches.length]);

  const prevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setFindIdx((i) => (i - 1 + matches.length) % matches.length);
  }, [matches.length]);

  if (!parsed.ok) {
    return (
      <div className={cn("flex flex-col bg-slate-900", fullscreen ? "fixed inset-0 z-50" : "h-full")}>
        <div className="px-3 py-1.5 text-[11px] text-amber-300 bg-amber-900/30 border-b border-amber-800/50 shrink-0">
          Unable to parse JSON ({parsed.error}). Showing raw contents.
        </div>
        <div className="flex-1 min-h-0">
          <FileContentViewer content={content} fileName={fileName} highlightLine={highlightLine} />
        </div>
      </div>
    );
  }

  const currentMatchLine =
    mode === "raw" && matches.length > 0 ? matches[clampedIdx] : highlightLine;
  const matchLineSet = mode === "raw" ? new Set(matchesRaw) : undefined;

  return (
    <div className={cn("flex flex-col bg-slate-900 text-slate-300 min-h-0", fullscreen ? "fixed inset-0 z-50" : "h-full")}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 shrink-0 text-[11px]">
        <div className="flex rounded bg-slate-800 overflow-hidden">
          <button
            type="button"
            onClick={() => setMode("tree")}
            className={cn(
              "px-2 py-0.5 transition-colors",
              mode === "tree" ? "bg-sky-900/60 text-sky-200" : "text-slate-400 hover:text-slate-200",
            )}
          >
            Tree
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={cn(
              "px-2 py-0.5 transition-colors",
              mode === "raw" ? "bg-sky-900/60 text-sky-200" : "text-slate-400 hover:text-slate-200",
            )}
          >
            Raw
          </button>
        </div>

        {mode === "tree" && maxDepth >= 1 && (
          <div className="flex items-center gap-0.5 bg-slate-800 rounded px-1.5 py-0.5">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 pr-1">Level</span>
            {Array.from({ length: maxDepth }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => applyLevel(n)}
                className="px-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                title={`Expand to level ${n}`}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              onClick={() => applyLevel(maxDepth + 1)}
              className="px-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700"
              title="Expand every node"
            >
              All
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setWrap((w) => !w)}
          aria-pressed={wrap}
          title={wrap ? "Disable line wrap (raw mode)" : "Enable line wrap (raw mode)"}
          className={cn(
            "px-2 py-0.5 rounded transition-colors",
            wrap
              ? "bg-sky-900/40 text-sky-300 hover:bg-sky-900/60"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800",
          )}
        >
          Wrap
        </button>

        <div className="flex items-center gap-1 bg-slate-800 rounded px-2 py-0.5">
          <svg className="w-3 h-3 text-slate-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Find…"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) prevMatch();
                else nextMatch();
              } else if (e.key === "Escape") {
                setFindQuery("");
              }
            }}
            className="bg-transparent outline-none w-32 text-slate-200 placeholder-slate-500"
          />
          {findQuery && (
            <>
              <span className="text-[10px] text-slate-500 tabular-nums shrink-0">
                {matches.length > 0 ? `${clampedIdx + 1}/${matches.length}` : "0"}
              </span>
              <button
                type="button"
                onClick={prevMatch}
                className="text-slate-500 hover:text-slate-200 px-0.5"
                title="Previous match (Shift+Enter)"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={nextMatch}
                className="text-slate-500 hover:text-slate-200 px-0.5"
                title="Next match (Enter)"
              >
                ↓
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-1 bg-slate-800 rounded px-2 py-0.5">
          <span className="text-[10px] text-slate-500 shrink-0">Go to key:</span>
          <input
            type="text"
            placeholder="key name"
            value={jumpKey}
            onChange={(e) => setJumpKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleJumpKey();
              }
            }}
            className="bg-transparent outline-none w-28 text-slate-200 placeholder-slate-500"
          />
        </div>

        <button
          type="button"
          onClick={() => setFullscreen((f) => !f)}
          aria-pressed={fullscreen}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          className={cn(
            "ml-auto px-1.5 py-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors",
            fullscreen && "bg-sky-900/40 text-sky-300 hover:bg-sky-900/60",
          )}
        >
          {fullscreen
            ? <Minimize2 className="w-3.5 h-3.5" strokeWidth={2} />
            : <Maximize2 className="w-3.5 h-3.5" strokeWidth={2} />}
        </button>
      </div>

      {/* Path breadcrumb */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-slate-800 shrink-0 text-[11px] text-slate-400">
        <span className="text-slate-500 shrink-0">Path:</span>
        <code className="text-slate-200 truncate flex-1">{displayPath(selectedPath)}</code>
        <button
          type="button"
          onClick={copyPath}
          className={cn(
            "px-1.5 py-0.5 rounded text-[10px] shrink-0",
            pathCopied ? "text-emerald-400" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800",
          )}
        >
          {pathCopied ? "Copied" : "Copy path"}
        </button>
      </div>

      {/* Content + Outline */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div
          ref={contentScrollRef}
          className={cn("flex-1 min-w-0 min-h-0 scrollbar-thin", mode === "tree" ? "overflow-auto" : "overflow-hidden")}
        >
          {mode === "tree" ? (
            <TreeView
              rows={treeRows}
              selectedPath={selectedPath}
              matchRows={new Set(matchesTree)}
              currentMatchRow={mode === "tree" && matches.length > 0 ? matches[clampedIdx] : -1}
              onToggle={toggleExpanded}
              onSelectPath={setSelectedPath}
              query={findQuery}
            />
          ) : (
            <FileContentViewer
              content={prettyRaw.text}
              fileName={fileName}
              highlightLine={currentMatchLine}
              matchLines={matchLineSet}
              wrap={wrap}
              scrollRequest={rawScrollRequest ?? undefined}
              onLineClick={(ln) => {
                const p = prettyRaw.pathByLine[ln - 1];
                if (p) setSelectedPath(p);
              }}
            />
          )}
        </div>

        {toc.length > 0 && (
          <>
            <div
              onMouseDown={startSidebarDrag}
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize outline"
              className="w-1 shrink-0 cursor-col-resize bg-slate-800 hover:bg-sky-500/60 transition-colors"
            />
          <aside
            style={{ width: sidebarWidth }}
            className="shrink-0 border-l border-slate-800 bg-slate-900/70 overflow-auto scrollbar-thin"
          >
            <div className="px-3 py-1.5 text-[10px] uppercase text-slate-500 font-semibold tracking-wider border-b border-slate-800 sticky top-0 bg-slate-900/90 backdrop-blur">
              Outline
            </div>
            <div className="py-1">
              {toc.map((t) => {
                const active =
                  selectedPath === t.path ||
                  selectedPath.startsWith(`${t.path}.`) ||
                  selectedPath.startsWith(`${t.path}[`);
                return (
                  <button
                    key={t.path}
                    type="button"
                    onClick={() => goToPath(t.path)}
                    className={cn(
                      "block w-full text-left px-3 py-0.5 text-xs font-mono truncate transition-colors",
                      active
                        ? "bg-sky-900/40 text-sky-200"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-800",
                    )}
                    title={t.path}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </aside>
          </>
        )}
      </div>
    </div>
  );
}

// ── Tree view ─────────────────────────────────────────────────────────────────

function TreeView({
  rows,
  selectedPath,
  matchRows,
  currentMatchRow,
  onToggle,
  onSelectPath,
  query,
}: {
  rows: TreeRow[];
  selectedPath: string;
  matchRows: Set<number>;
  currentMatchRow: number;
  onToggle: (path: string) => void;
  onSelectPath: (path: string) => void;
  query: string;
}) {
  return (
    <div className="code-mono text-[13px] leading-[1.55] py-2 min-w-full">
      {rows.map((row, i) => {
        const isSelected =
          selectedPath === row.path && (row.kind === "open" || row.kind === "collapsed" || row.kind === "leaf");
        return (
          <TreeRowView
            key={`${row.path}-${row.kind}-${i}`}
            row={row}
            rowIndex={i}
            isSelected={isSelected}
            isMatch={matchRows.has(i)}
            isCurrentMatch={currentMatchRow === i}
            onToggle={onToggle}
            onSelectPath={onSelectPath}
            query={query}
          />
        );
      })}
    </div>
  );
}

function TreeRowView({
  row,
  rowIndex,
  isSelected,
  isMatch,
  isCurrentMatch,
  onToggle,
  onSelectPath,
  query,
}: {
  row: TreeRow;
  rowIndex: number;
  isSelected: boolean;
  isMatch: boolean;
  isCurrentMatch: boolean;
  onToggle: (path: string) => void;
  onSelectPath: (path: string) => void;
  query: string;
}) {
  const expandable = row.kind === "open" || row.kind === "collapsed";
  const indent = row.depth * 16 + 8;

  const bgClass = isCurrentMatch
    ? "bg-amber-900/50"
    : isMatch
      ? "bg-amber-900/20"
      : isSelected
        ? "bg-slate-800"
        : "hover:bg-slate-800/50";

  const handleClick = () => {
    onSelectPath(row.path);
    if (expandable) onToggle(row.path);
  };

  return (
    <div
      data-row={rowIndex}
      data-path={row.path}
      onClick={handleClick}
      className={cn("flex items-start leading-5 cursor-pointer pr-4 select-text", bgClass)}
      style={{ paddingLeft: indent }}
    >
      <span className="inline-block w-3 shrink-0 text-slate-500 select-none text-[10px] leading-5">
        {row.kind === "open" ? "▼" : row.kind === "collapsed" ? "▶" : ""}
      </span>
      <RowContent row={row} query={query} />
    </div>
  );
}

function RowContent({ row, query }: { row: TreeRow; query: string }) {
  const keyEl =
    row.kind !== "close" && row.keyLabel !== null ? (
      <>
        <Hl text={`"${row.keyLabel}"`} query={query} className="text-sky-300" />
        <span className="text-slate-500">: </span>
      </>
    ) : null;

  switch (row.kind) {
    case "open":
      return (
        <span>
          {keyEl}
          <span className="text-slate-400">{row.bracket}</span>
        </span>
      );
    case "close":
      return (
        <span>
          <span className="text-slate-400">{row.bracket}</span>
          {row.trailingComma && <span className="text-slate-500">,</span>}
        </span>
      );
    case "leaf": {
      const color =
        row.valueType === "string"
          ? "text-lime-300"
          : row.valueType === "number"
            ? "text-amber-300"
            : row.valueType === "boolean"
              ? "text-pink-300"
              : row.valueType === "null"
                ? "text-slate-500 italic"
                : "text-slate-500";
      return (
        <span className="min-w-0 break-all">
          {keyEl}
          <Hl text={row.valueText} query={query} className={color} />
          {row.trailingComma && <span className="text-slate-500">,</span>}
        </span>
      );
    }
    case "collapsed":
      return (
        <span>
          {keyEl}
          <span className="text-slate-400">{row.container === "array" ? "[" : "{"}</span>
          <span className="text-slate-500 italic px-2">
            {row.count} {row.container === "array" ? (row.count === 1 ? "item" : "items") : row.count === 1 ? "key" : "keys"}
          </span>
          <span className="text-slate-400">{row.container === "array" ? "]" : "}"}</span>
          {row.trailingComma && <span className="text-slate-500">,</span>}
        </span>
      );
  }
}

function Hl({ text, query, className }: { text: string; query: string; className?: string }) {
  if (!query) return <span className={className}>{text}</span>;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: { text: string; mark: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      parts.push({ text: text.slice(i), mark: false });
      break;
    }
    if (j > i) parts.push({ text: text.slice(i, j), mark: false });
    parts.push({ text: text.slice(j, j + q.length), mark: true });
    i = j + q.length;
  }
  return (
    <span className={className}>
      {parts.map((p, k) => (
        <Fragment key={k}>
          {p.mark ? <mark className="bg-amber-300/70 text-slate-900 rounded-sm px-[1px]">{p.text}</mark> : p.text}
        </Fragment>
      ))}
    </span>
  );
}

// Escape a string for use inside a CSS attribute selector (for data-path lookups).
function cssEscape(s: string): string {
  return s.replace(/(["\\\[\]])/g, "\\$1");
}
