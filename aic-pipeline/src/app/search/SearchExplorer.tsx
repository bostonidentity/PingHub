"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Environment } from "@/lib/fr-config-types";
import { EnvironmentBadge } from "@/components/EnvironmentBadge";
import { FileContentViewer } from "@/components/FileContentViewer";
import { cn } from "@/lib/utils";
import type { SearchResponse, SearchFileResult } from "@/app/search/types";
import { useWorkingEnv } from "@/hooks/useWorkingEnv";

const DEFAULT_GLOB = "**/*.{js,groovy,json}";

const GLOB_PRESETS: { label: string; value: string }[] = [
  { label: "All",                 value: "" },
  { label: "JS",                  value: "**/*.js" },
  { label: "Groovy",              value: "**/*.groovy" },
  { label: "JSON",                value: "**/*.json" },
  { label: "Scripts (JS+Groovy)", value: "**/*.{js,groovy}" },
  { label: "Endpoints",           value: "endpoints/**" },
  { label: "Realm scripts",       value: "realms/**/scripts/**" },
  { label: "Journeys",            value: "realms/**/journeys/**" },
  { label: "Custom nodes",        value: "custom-nodes/**" },
  { label: "Email templates",     value: "email-templates/**" },
  { label: "IGA workflows",       value: "iga/workflows/**" },
  { label: "IGA workflow scripts", value: "iga/workflows/**/*.js" },
  { label: "IGA (all)",           value: "iga/**" },
];

interface Props {
  environments: Environment[];
}

const STORAGE_KEY = "global-search-state-v1";

interface PersistedState {
  env: string;
  query: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  glob: string;
  data: SearchResponse | null;
  expanded: string[];
  selected: { path: string; line: number } | null;
}

function loadPersisted(): Partial<PersistedState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PersistedState>) : {};
  } catch { return {}; }
}

export function SearchExplorer({ environments }: Props) {
  const [workingEnv] = useWorkingEnv();

  // Initial state must match SSR (localStorage is client-only). We rehydrate
  // from localStorage in a post-mount effect below — before that fires, the
  // first client render matches the server so React can hydrate cleanly.
  const [env, setEnv] = useState<string>(environments[0]?.name || "");
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [glob, setGlob] = useState(DEFAULT_GLOB);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ path: string; line: number } | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [fileLoading, setFileLoading] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);

  const [hydrated, setHydrated] = useState(false);
  const hadPersistedEnvRef = useRef(false);

  useEffect(() => {
    const p = loadPersisted();
    if (p.env) { setEnv(p.env); hadPersistedEnvRef.current = true; }
    if (p.query != null) setQuery(p.query);
    if (p.regex != null) setRegex(p.regex);
    if (p.matchCase != null) setMatchCase(p.matchCase);
    if (p.wholeWord != null) setWholeWord(p.wholeWord);
    if (p.glob) setGlob(p.glob);
    if (p.data != null) setData(p.data);
    if (p.expanded) setExpanded(new Set(p.expanded));
    if (p.selected != null) setSelected(p.selected);
    setHydrated(true);
  }, []);

  // Fall through to workingEnv only when nothing was persisted for this view.
  useEffect(() => {
    if (!hydrated) return;
    if (workingEnv && workingEnv !== env && !hadPersistedEnvRef.current) setEnv(workingEnv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, workingEnv]);

  // Persist whenever any non-ephemeral state changes — but not until after
  // rehydration, or we'd overwrite localStorage with empty defaults on first
  // render.
  useEffect(() => {
    if (!hydrated) return;
    try {
      const payload: PersistedState = {
        env, query, regex, matchCase, wholeWord, glob,
        data, expanded: Array.from(expanded), selected,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch { /* ignore quota errors */ }
  }, [hydrated, env, query, regex, matchCase, wholeWord, glob, data, expanded, selected]);


  useEffect(() => {
    if (!previewFullscreen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setPreviewFullscreen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [previewFullscreen]);

  const handleCopyFile = () => {
    if (!fileContent) return;
    navigator.clipboard.writeText(fileContent).then(() => {
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1500);
    });
  };

  const abortRef = useRef<AbortController | null>(null);

  const handleClearAll = () => {
    abortRef.current?.abort();
    setQuery("");
    setData(null);
    setError("");
    setExpanded(new Set());
    setSelected(null);
    setFileContent("");
  };

  const runSearch = useCallback(async () => {
    if (!env || !query.trim()) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        env,
        q: query,
        regex: regex ? "1" : "0",
        case: matchCase ? "1" : "0",
        word: wholeWord ? "1" : "0",
      });
      if (glob) params.set("glob", glob);
      const res = await fetch(`/api/search?${params.toString()}`, { signal: ctl.signal });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Search failed");
        setData(null);
      } else {
        setData(body as SearchResponse);
        // Auto-expand first 10 files so users immediately see hits
        const firstFew = (body.results as SearchFileResult[]).slice(0, 10).map((r) => r.path);
        setExpanded(new Set(firstFew));
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }, [env, query, regex, matchCase, wholeWord, glob]);

  // Load file content when a hit is clicked
  useEffect(() => {
    if (!selected) { setFileContent(""); return; }
    setFileLoading(true);
    const ctl = new AbortController();
    fetch(`/api/configs/${encodeURIComponent(env)}/file?path=${encodeURIComponent(selected.path)}`, { signal: ctl.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => setFileContent(d.content ?? ""))
      .catch((e) => { if ((e as Error).name !== "AbortError") setFileContent(`// failed to load: ${(e as Error).message}`); })
      .finally(() => setFileLoading(false));
    return () => ctl.abort();
  }, [selected, env]);

  const grouped = useMemo(() => {
    if (!data) return [] as { scope: string; files: SearchFileResult[] }[];
    const m = new Map<string, SearchFileResult[]>();
    for (const r of data.results) {
      const arr = m.get(r.scope) ?? [];
      arr.push(r);
      m.set(r.scope, arr);
    }
    return Array.from(m.entries())
      .map(([scope, files]) => ({ scope, files }))
      .sort((a, b) => {
        // "(root)" / unknown scopes sink to the bottom; everything else is alpha.
        const rank = (s: string) => (s && s !== "other" ? 0 : 1);
        const d = rank(a.scope) - rank(b.scope);
        return d !== 0 ? d : a.scope.localeCompare(b.scope);
      });
  }, [data]);

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  function highlightLine(text: string, submatches: { start: number; end: number }[]) {
    if (!submatches.length) return <>{text}</>;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    submatches.sort((a, b) => a.start - b.start).forEach((sm, i) => {
      if (sm.start > cursor) parts.push(<span key={`p${i}`}>{text.slice(cursor, sm.start)}</span>);
      parts.push(<mark key={`m${i}`} className="bg-yellow-200 text-inherit rounded-sm px-0.5">{text.slice(sm.start, sm.end)}</mark>);
      cursor = sm.end;
    });
    if (cursor < text.length) parts.push(<span key="end">{text.slice(cursor)}</span>);
    return <>{parts}</>;
  }

  const totalHits = data?.totalMatches ?? 0;
  const totalFiles = data?.totalFiles ?? 0;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="card-padded space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="label-xs">Environment</label>
            <select
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              className="block px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
            >
              {environments.map((e) => (
                <option key={e.name} value={e.name}>{e.label}</option>
              ))}
            </select>
          </div>
          {environments.find((e) => e.name === env) && (
            <div className="pb-0.5">
              <EnvironmentBadge env={environments.find((e) => e.name === env)!} />
            </div>
          )}
          <div className="space-y-1 flex-1 min-w-[280px]">
            <label className="label-xs">Query</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
              placeholder={regex ? "Regex pattern…" : "Literal text to find…"}
              className="block w-full px-3 py-2.5 rounded-lg border border-slate-200 text-[13px] font-mono outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
            />
          </div>
          {loading ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="px-3 py-2 text-sm font-medium bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={runSearch}
              disabled={!env || !query.trim()}
              className="btn-primary disabled:opacity-40"
            >
              Search
            </button>
          )}
          <button
            type="button"
            onClick={handleClearAll}
            disabled={!query && !data && !error}
            className="px-3 py-2 text-sm font-medium border border-slate-300 text-slate-600 rounded-lg bg-white hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Clear filter and results"
          >
            Clear
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded border border-slate-300 overflow-hidden shrink-0">
            <button
              type="button"
              title="Case sensitive"
              onClick={() => setMatchCase((v) => !v)}
              className={cn("px-2 py-0.5 text-[11px] font-medium font-mono transition-colors", matchCase ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}
            >Aa</button>
            <button
              type="button"
              title="Whole word"
              onClick={() => setWholeWord((v) => !v)}
              className={cn("px-2 py-0.5 text-[11px] font-medium font-mono border-l border-slate-300 transition-colors", wholeWord ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}
            >[W]</button>
            <button
              type="button"
              title="Regex"
              onClick={() => setRegex((v) => !v)}
              className={cn("px-2 py-0.5 text-[11px] font-medium font-mono border-l border-slate-300 transition-colors", regex ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-50")}
            >.*</button>
          </div>
          <input
            type="text"
            value={glob}
            onChange={(e) => setGlob(e.target.value)}
            placeholder="File glob (e.g. **/*.js)"
            className="flex-1 min-w-[200px] px-3 py-1.5 rounded border border-slate-300 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          {glob !== DEFAULT_GLOB && (
            <button
              type="button"
              onClick={() => setGlob(DEFAULT_GLOB)}
              title={`Reset to default (${DEFAULT_GLOB})`}
              className="px-2 py-1 text-[11px] rounded border border-slate-300 text-slate-600 bg-white hover:bg-slate-50 transition-colors shrink-0"
            >
              Reset
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-400 mr-1">Presets:</span>
          {GLOB_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setGlob(p.value)}
              className={cn(
                "px-2 py-0.5 text-[11px] rounded border transition-colors",
                glob === p.value
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-500 border-slate-300 hover:bg-slate-50"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Result summary */}
      {data && !error && (
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            {totalHits.toLocaleString()} match{totalHits === 1 ? "" : "es"} in {totalFiles.toLocaleString()} file{totalFiles === 1 ? "" : "s"}
          </span>
          {data.truncated && <span className="text-amber-600">· results truncated</span>}
        </div>
      )}

      {/* Results + file preview split */}
      {data && !error && data.results.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
          {/* Results list */}
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden flex flex-col max-h-[calc(100vh-320px)]">
            <div className="flex items-center gap-3 px-3 py-1.5 border-b border-slate-200 bg-slate-50/50 shrink-0">
              <button
                type="button"
                onClick={() => setExpanded(new Set(data.results.map((r) => r.path)))}
                className="text-[11px] text-slate-500 hover:text-slate-800 transition-colors"
              >
                Expand all
              </button>
              <span className="text-slate-300 text-[10px]">·</span>
              <button
                type="button"
                onClick={() => setExpanded(new Set())}
                className="text-[11px] text-slate-500 hover:text-slate-800 transition-colors"
              >
                Collapse all
              </button>
              <span className="ml-auto text-[10px] text-slate-400">
                {expanded.size} / {data.results.length} expanded
              </span>
            </div>
            <div className="overflow-y-auto flex-1">
              {grouped.map(({ scope, files }) => (
                <div key={scope}>
                  <div className="sticky top-0 bg-slate-50/95 backdrop-blur px-4 py-1.5 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {scope || "(root)"} · {files.length} file{files.length === 1 ? "" : "s"}
                  </div>
                  {files.map((f) => {
                    const isOpen = expanded.has(f.path);
                    return (
                      <div key={f.path} className="border-b border-slate-100">
                        <button
                          type="button"
                          onClick={() => toggleExpand(f.path)}
                          className="w-full flex items-center gap-2 px-4 py-1.5 hover:bg-slate-50 text-left"
                        >
                          <span className="text-slate-400 text-[10px] w-3">{isOpen ? "▾" : "▸"}</span>
                          <span className="flex-1 text-xs font-mono text-slate-700 truncate">{f.path}</span>
                          <span className="text-[10px] text-slate-400 shrink-0">{f.matches.length}</span>
                        </button>
                        {isOpen && (
                          <div className="bg-slate-50/50">
                            {f.matches.map((m, i) => (
                              <button
                                key={i}
                                type="button"
                                onClick={() => setSelected({ path: f.path, line: m.line })}
                                className={cn(
                                  "w-full flex gap-3 px-4 py-1 text-[11px] font-mono text-left hover:bg-sky-50 border-l-2",
                                  selected?.path === f.path && selected.line === m.line
                                    ? "bg-sky-100 border-sky-500"
                                    : "border-transparent"
                                )}
                              >
                                <span className="text-slate-400 w-10 shrink-0 text-right">{m.line}</span>
                                <span className="text-slate-700 whitespace-pre break-all">
                                  {highlightLine(m.text, m.submatches)}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* File preview */}
          <div className={cn(
            "bg-white border border-slate-200 overflow-hidden flex flex-col",
            previewFullscreen
              ? "fixed inset-0 z-50 rounded-none"
              : "rounded-lg max-h-[calc(100vh-320px)]"
          )}>
            {selected ? (
              <>
                <div className="px-4 py-2 border-b border-slate-200 bg-slate-50/50 flex items-center gap-3">
                  <span className="text-xs font-mono text-slate-700 truncate flex-1 min-w-0">{selected.path}</span>
                  <span className="text-[10px] text-slate-400 shrink-0">line {selected.line}</span>
                  <a
                    href={`/configs?env=${encodeURIComponent(env)}&file=${encodeURIComponent(selected.path)}&line=${selected.line}`}
                    target="_blank"
                    rel="noopener"
                    className="text-[11px] text-sky-600 hover:text-sky-800 hover:underline shrink-0"
                    title="Open this file in the Browse tab"
                  >
                    Find in Browse ↗
                  </a>
                  <button
                    type="button"
                    onClick={handleCopyFile}
                    disabled={!fileContent || fileLoading}
                    title="Copy file contents"
                    className={cn(
                      "text-xs transition-colors shrink-0",
                      copyFlash ? "text-emerald-600" : "text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    )}
                  >
                    {copyFlash ? "Copied!" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewFullscreen((v) => !v)}
                    title={previewFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
                    className="text-slate-400 hover:text-slate-700 transition-colors shrink-0"
                  >
                    {previewFullscreen ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  {fileLoading ? (
                    <div className="p-4 text-slate-400 text-xs">Loading…</div>
                  ) : (
                    <FileContentViewer
                      content={fileContent}
                      fileName={selected.path}
                      highlightLine={selected.line}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center flex-1 text-xs text-slate-400">
                Click a match to preview
              </div>
            )}
          </div>
        </div>
      )}

      {data && !error && data.results.length === 0 && (
        <div className="text-center text-sm text-slate-400 py-8">No matches.</div>
      )}
    </div>
  );
}

