// src/app/data/browse/BrowsePanel.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Environment } from "@/lib/fr-config";
import type { SnapshotType } from "@/lib/data/types";
import type { GlobalSearchHit, GlobalSearchResponse } from "@/app/api/data/search/[env]/route";
import { useSnapshotRecords } from "@/hooks/useSnapshotRecords";
import { RecordDetailPane } from "./RecordDetailPane";
import { cn } from "@/lib/utils";

// Per-(env,type) user preference for which record attribute drives the list
// column. Stored in localStorage so it survives reloads. Empty string means
// "use the server default".
const TITLE_PREF_KEY = "data-browse-title-pref-v1";
function loadTitlePrefs(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(TITLE_PREF_KEY);
    return raw ? JSON.parse(raw) as Record<string, string> : {};
  } catch { return {}; }
}
function saveTitlePrefs(prefs: Record<string, string>): void {
  try { localStorage.setItem(TITLE_PREF_KEY, JSON.stringify(prefs)); } catch { /* quota */ }
}
const prefKey = (env: string, type: string) => `${env}::${type}`;

export function BrowsePanel({ environments }: { environments: Environment[] }) {
  const [env, setEnv] = useState(environments[0]?.name ?? "");
  const [types, setTypes] = useState<SnapshotType[]>([]);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [titlePrefs, setTitlePrefs] = useState<Record<string, string>>({});

  // Rehydrate display-attribute preferences after mount. Kept out of the
  // useState initializer so server and client renders agree before hydration.
  useEffect(() => { setTitlePrefs(loadTitlePrefs()); }, []);

  useEffect(() => {
    if (!env) return;
    fetch(`/api/data/snapshots/${env}`)
      .then((r) => r.ok ? r.json() : { types: [] })
      .then((d: { types: SnapshotType[] }) => {
        setTypes(d.types);
        setSelectedType((prev) => prev && d.types.some((t) => t.name === prev) ? prev : d.types[0]?.name ?? null);
      })
      .catch(() => setTypes([]));
  }, [env]);

  const titleField = selectedType ? (titlePrefs[prefKey(env, selectedType)] || undefined) : undefined;
  const { q, setQ, page, setPage, data, loading } = useSnapshotRecords(env, selectedType, titleField);

  function setTitleFieldForCurrent(field: string) {
    if (!selectedType) return;
    const next = { ...titlePrefs, [prefKey(env, selectedType)]: field };
    setTitlePrefs(next);
    saveTitlePrefs(next);
  }

  // ── Global search (across all types) ─────────────────────────────────────
  const [globalQ, setGlobalQ] = useState("");
  const [globalRegex, setGlobalRegex] = useState(false);
  const [globalCaseSensitive, setGlobalCaseSensitive] = useState(false);
  const [globalHits, setGlobalHits] = useState<GlobalSearchHit[]>([]);
  const [globalTruncated, setGlobalTruncated] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const globalDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!env || !globalQ.trim()) {
      setGlobalHits([]); setGlobalTruncated(false); setGlobalError(null);
      return;
    }
    let cancelled = false;
    if (globalDebounceRef.current) clearTimeout(globalDebounceRef.current);
    globalDebounceRef.current = setTimeout(async () => {
      if (cancelled) return;
      setGlobalLoading(true);
      try {
        const params = new URLSearchParams({ q: globalQ });
        if (globalRegex) params.set("regex", "true");
        if (globalCaseSensitive) params.set("caseSensitive", "true");
        const res = await fetch(`/api/data/search/${env}?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as GlobalSearchResponse;
        if (!cancelled) {
          setGlobalHits(json.hits);
          setGlobalTruncated(json.truncated);
          setGlobalError(json.error ?? null);
        }
      } catch (e) {
        if (!cancelled) setGlobalError((e as Error).message);
      } finally {
        if (!cancelled) setGlobalLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      if (globalDebounceRef.current) clearTimeout(globalDebounceRef.current);
    };
  }, [env, globalQ, globalRegex, globalCaseSensitive]);

  const globalHitsByType = useMemo(() => {
    const m = new Map<string, GlobalSearchHit[]>();
    for (const h of globalHits) {
      if (!m.has(h.type)) m.set(h.type, []);
      m.get(h.type)!.push(h);
    }
    return m;
  }, [globalHits]);

  function jumpTo(type: string, id: string) {
    setSelectedType(type);
    setSelectedId(id);
    setPage(1);
    setQ("");
  }
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const exportUrl = useMemo(() => {
    if (!selectedType) return null;
    const params = new URLSearchParams({ q });
    return (format: "json" | "csv") =>
      `/api/data/export/${env}/${selectedType}?${params.toString()}&format=${format}`;
  }, [env, selectedType, q]);

  const globalActive = globalQ.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 font-medium">Environment</label>
          <select
            value={env}
            onChange={(e) => { setEnv(e.target.value); setSelectedId(null); }}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded bg-white text-slate-800"
          >
            {environments.map((e) => (
              <option key={e.name} value={e.name}>{e.label ?? e.name}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[240px] flex flex-col gap-1">
          <label className="text-xs text-slate-500 font-medium">
            Search all types
            {globalLoading && <span className="ml-2 text-slate-400">loading…</span>}
            {globalError && <span className="ml-2 text-rose-600">{globalError}</span>}
            {!globalError && globalActive && !globalLoading && (
              <span className="ml-2 text-slate-400">
                {globalHits.length} hit{globalHits.length === 1 ? "" : "s"}{globalTruncated ? " (capped)" : ""}
              </span>
            )}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={globalQ}
              onChange={(e) => setGlobalQ(e.target.value)}
              placeholder={globalRegex ? "Regex, e.g. ^alice\\d+" : "Substring to match anywhere in any record…"}
              className="flex-1 text-sm rounded border border-slate-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer select-none">
              <input type="checkbox" checked={globalRegex} onChange={(e) => setGlobalRegex(e.target.checked)} className="accent-sky-600" />
              regex
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer select-none">
              <input type="checkbox" checked={globalCaseSensitive} onChange={(e) => setGlobalCaseSensitive(e.target.checked)} className="accent-sky-600" />
              Aa
            </label>
            {globalQ && (
              <button type="button" onClick={() => setGlobalQ("")} className="text-xs text-slate-400 hover:text-slate-600" title="Clear">✕</button>
            )}
          </div>
        </div>
      </div>

      {globalActive && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Global results
          </div>
          {globalHits.length === 0 && !globalLoading && !globalError ? (
            <div className="p-4 text-xs text-slate-400 italic">No matches across any type.</div>
          ) : (
            <div className="max-h-[40vh] overflow-y-auto divide-y divide-slate-100">
              {[...globalHitsByType.entries()].map(([type, hits]) => (
                <div key={type}>
                  <div className="px-3 py-1 bg-slate-50 border-b border-slate-100 flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="font-mono text-slate-700">{type}</span>
                    <span className="text-slate-400">{hits.length}</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {hits.map((h) => (
                      <button
                        key={`${h.type}/${h.id}`}
                        type="button"
                        onClick={() => jumpTo(h.type, h.id)}
                        className="w-full text-left px-3 py-1.5 hover:bg-sky-50 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-slate-800 truncate font-mono">{h.id}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono truncate">{h.preview}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {types.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-6 text-center text-sm text-slate-500">
          No data pulled yet for <span className="font-mono">{env}</span>.{" "}
          <a href="/data/pull" className="text-sky-600 hover:underline">Pull now →</a>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-2">
            {types.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => { setSelectedType(t.name); setSelectedId(null); setPage(1); }}
                className={cn(
                  "px-3 py-1 text-xs rounded transition-colors",
                  selectedType === t.name
                    ? "bg-sky-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                )}
              >
                {t.name} <span className="opacity-70">({t.count})</span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4">
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col min-h-[500px] max-h-[calc(100vh-280px)]">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={q}
                  onChange={(e) => { setQ(e.target.value); setPage(1); }}
                  placeholder="Search anywhere in each record…"
                  className="flex-1 min-w-[160px] text-xs rounded border border-slate-300 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-sky-400"
                />
                {data && data.fields.length > 0 && (
                  <label className="flex items-center gap-1 text-[10px] text-slate-500">
                    <span>Display:</span>
                    <select
                      value={titleField ?? ""}
                      onChange={(e) => setTitleFieldForCurrent(e.target.value)}
                      className="text-[11px] rounded border border-slate-300 bg-white px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
                      title="Attribute used as the row title"
                    >
                      <option value="">default</option>
                      {data.fields.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                )}
                {exportUrl && (
                  <>
                    <a href={exportUrl("json")} className="text-[11px] text-sky-600 hover:underline">JSON</a>
                    <span className="text-slate-300">·</span>
                    <a href={exportUrl("csv")} className="text-[11px] text-sky-600 hover:underline">CSV</a>
                  </>
                )}
              </div>
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {loading && !data && <div className="p-4 text-xs text-slate-400">Loading…</div>}
                {data?.records.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    className={cn(
                      "w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors",
                      selectedId === r.id && "bg-sky-50",
                    )}
                  >
                    <div className="text-xs font-medium text-slate-800 truncate">{r.title}</div>
                  </button>
                ))}
                {data && data.records.length === 0 && (
                  <div className="p-4 text-xs text-slate-400 italic">No matches.</div>
                )}
              </div>
              {data && (
                <div className="flex items-center justify-between px-3 py-1.5 border-t border-slate-100 text-[11px] text-slate-500">
                  <span>Page {data.page} / {totalPages} · {data.total} records</span>
                  <div className="flex items-center gap-1">
                    <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                      className="px-2 py-0.5 border border-slate-300 rounded disabled:opacity-30">←</button>
                    <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
                      className="px-2 py-0.5 border border-slate-300 rounded disabled:opacity-30">→</button>
                  </div>
                </div>
              )}
            </div>

            <RecordDetailPane env={env} type={selectedType} id={selectedId} />
          </div>
        </>
      )}
    </div>
  );
}
