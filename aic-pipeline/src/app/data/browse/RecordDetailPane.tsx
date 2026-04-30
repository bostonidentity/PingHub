// src/app/data/browse/RecordDetailPane.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { JsonFileViewer } from "@/components/JsonFileViewer";
import { cn } from "@/lib/utils";
import type { RefsResponse } from "@/app/api/data/refs/[env]/[type]/[id]/route";
import type { GlobalSearchResponse } from "@/app/api/data/search/[env]/route";
import type { TitlesResponse } from "@/app/api/data/titles/[env]/route";

// ── DepGroup helper ──────────────────────────────────────────────────────────

function DepGroup({
  refType, refs, fields, chosen, env,
  titlesByRef, onNavigate, onChooseField, titleSuffix = "",
}: {
  refType: string;
  refs: { type: string; id: string }[];
  fields: string[];
  chosen: string;
  env: string;
  titlesByRef: Record<string, string | null>;
  onNavigate?: (type: string, id: string) => void;
  onChooseField: (env: string, type: string, field: string) => void;
  titleSuffix?: string;
}) {
  return (
    <div className="ml-2 mb-1">
      <div className="flex items-center gap-2">
        <span className="text-slate-400">{refType}</span>
        {fields.length > 0 && (
          <label className="flex items-center gap-1 text-[10px] text-slate-500">
            <span>Display:</span>
            <select
              value={chosen}
              onChange={(e) => onChooseField(env, refType, e.target.value)}
              className="text-[11px] rounded border border-slate-300 bg-white px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
              title="Attribute used as the dependency label"
              aria-label={`Display attribute for ${refType}`}
            >
              <option value="">default</option>
              {fields.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="ml-2 flex flex-wrap gap-x-2 gap-y-0.5">
        {refs.map((r) => {
          const label = titlesByRef[`${r.type}/${r.id}`] ?? r.id;
          return (
            <button
              key={`${r.type}:${r.id}`}
              type="button"
              onClick={() => onNavigate?.(r.type, r.id)}
              title={`${r.type}/${r.id}${titleSuffix}`}
              className="font-mono text-sky-600 hover:underline hover:text-sky-800 truncate max-w-[240px]"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function RecordDetailPane({
  env, type, id, onNavigate, titlePrefs, setTitleFieldFor,
}: {
  env: string;
  type: string | null;
  id: string | null;
  onNavigate?: (type: string, id: string) => void;
  titlePrefs: Record<string, string>;
  setTitleFieldFor: (env: string, type: string, field: string) => void;
}) {
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!type || !id) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`/api/data/records/${env}/${type}/${id}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => { if (!cancelled) setRecord(d.record); })
      .catch(() => { if (!cancelled) setRecord(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [env, type, id]);

  const content = useMemo(() => (record ? JSON.stringify(record, null, 2) : ""), [record]);

  // ── Dependencies – lazy loaded on demand ─────────────────────────────────
  const [outgoing, setOutgoing] = useState<{ type: string; id: string }[]>([]);
  const [incoming, setIncoming] = useState<{ type: string; id: string }[]>([]);
  const [depsLoading, setDepsLoading] = useState(false);
  const [depsRequested, setDepsRequested] = useState(false);
  const [titlesByRef, setTitlesByRef] = useState<Record<string, string | null>>({});
  const [fieldsByType, setFieldsByType] = useState<Record<string, string[]>>({});
  const [titlesLoading, setTitlesLoading] = useState(false);
  const titleReqIdRef = useRef(0);

  // Reset deps when the selected record changes
  useEffect(() => {
    titleReqIdRef.current++;
    setOutgoing([]);
    setIncoming([]);
    setDepsRequested(false);
    setTitlesByRef({});
    setFieldsByType({});
    setTitlesLoading(false);
  }, [env, type, id]);

  // Fetch deps only when explicitly requested
  useEffect(() => {
    if (!depsRequested || !type || !id) return;
    let cancelled = false;
    setDepsLoading(true);

    fetch(`/api/data/refs/${env}/${type}/${id}`)
      .then((r) => r.ok ? r.json() : null)
      .then(async (data: RefsResponse | null) => {
        if (cancelled) return;

        if (data && !data.indexMissing) {
          setOutgoing(data.outgoing);
          setIncoming(data.incoming);
        } else {
          setOutgoing([]);
          const needle = `managed/${type}/${id}`;
          const params = new URLSearchParams({ q: needle, limit: "100" });
          const res = await fetch(`/api/data/search/${env}?${params.toString()}`);
          if (cancelled) return;
          if (res.ok) {
            const d = await res.json() as GlobalSearchResponse;
            const hits = d.hits.filter((h) => !(h.type === type && h.id === id));
            setIncoming(hits.map((h) => ({ type: h.type, id: h.id })));
          }
        }
      })
      .catch(() => { if (!cancelled) { setOutgoing([]); setIncoming([]); } })
      .finally(() => { if (!cancelled) setDepsLoading(false); });
    return () => { cancelled = true; };
  }, [depsRequested, env, type, id]);

  const allRefs = useMemo(
    () => [...outgoing, ...incoming],
    [outgoing, incoming],
  );

  const attrsByType = useMemo(() => {
    const types = new Set(allRefs.map((r) => r.type));
    const out: Record<string, string> = {};
    for (const t of types) {
      const v = titlePrefs[`${env}::${t}`];
      if (v) out[t] = v;
    }
    return out;
  }, [allRefs, titlePrefs, env]);

  const attrsByTypeKey = useMemo(
    () => Object.entries(attrsByType).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("|"),
    [attrsByType],
  );

  useEffect(() => {
    if (allRefs.length === 0) {
      titleReqIdRef.current++;
      setTitlesByRef({});
      setFieldsByType({});
      setTitlesLoading(false);
      return;
    }
    const reqId = ++titleReqIdRef.current;
    let cancelled = false;
    setTitlesLoading(true);
    fetch(`/api/data/titles/${env}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refs: allRefs, attrs: attrsByType }),
    })
      .then((r) => r.ok ? r.json() as Promise<TitlesResponse> : null)
      .then((data) => {
        if (cancelled || reqId !== titleReqIdRef.current || !data) return;
        setTitlesByRef(data.titles);
        setFieldsByType(data.fieldsByType);
      })
      .catch(() => { /* keep prior labels on transient failure */ })
      .finally(() => {
        if (!cancelled && reqId === titleReqIdRef.current) setTitlesLoading(false);
      });
    return () => { cancelled = true; };
  }, [env, allRefs, attrsByTypeKey]);

  // Group outgoing by type for display
  const outgoingByType = useMemo(() => {
    const m = new Map<string, { type: string; id: string }[]>();
    for (const r of outgoing) {
      if (!m.has(r.type)) m.set(r.type, []);
      m.get(r.type)!.push(r);
    }
    return m;
  }, [outgoing]);

  // Group incoming by type
  const incomingByType = useMemo(() => {
    const m = new Map<string, { type: string; id: string }[]>();
    for (const r of incoming) {
      if (!m.has(r.type)) m.set(r.type, []);
      m.get(r.type)!.push(r);
    }
    return m;
  }, [incoming]);

  const hasDeps = outgoing.length > 0 || incoming.length > 0;

  // ── Deps panel open/closed ───────────────────────────────────────────────
  const [depsOpen, setDepsOpen] = useState(true);

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col h-full">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2 text-xs text-slate-700 shrink-0">
        {type && id
          ? <><span className="font-mono">{type} / {id}</span></>
          : <span className="text-slate-400">Click a record to view details</span>}
      </div>

      {/* Dependencies panel – lazy loaded */}
      {type && id && record && !depsRequested && (
        <div className="border-b border-slate-100 shrink-0 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setDepsRequested(true)}
            className="text-[11px] font-semibold text-sky-600 hover:text-sky-800 hover:underline transition-colors"
          >
            Show Dependencies
          </button>
        </div>
      )}
      {type && id && record && depsRequested && (depsLoading || hasDeps) && (
        <div className="border-b border-slate-100 shrink-0">
          <button
            type="button"
            onClick={() => setDepsOpen((v) => !v)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <svg className={cn("w-3 h-3 transition-transform", depsOpen && "rotate-90")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Dependencies
            <span className="font-normal text-slate-400">
              {depsLoading ? "(loading…)" : `(${outgoing.length} outgoing, ${incoming.length} incoming)`}
            </span>
          </button>

          {depsOpen && (
            <div className="px-3 pb-2 max-h-[200px] overflow-y-auto space-y-2 text-[11px]">
              {titlesLoading ? (
                <div className="text-slate-400 italic">Loading dependencies…</div>
              ) : (
                <>
                  {/* Outgoing: records this one references */}
                  {outgoing.length > 0 && (
                    <div>
                      <div className="text-slate-500 font-semibold mb-0.5">
                        References <span className="font-normal text-slate-400">({outgoing.length})</span>
                      </div>
                      {[...outgoingByType.entries()].map(([refType, refs]) => (
                        <DepGroup
                          key={refType}
                          refType={refType}
                          refs={refs}
                          fields={fieldsByType[refType] ?? []}
                          chosen={titlePrefs[`${env}::${refType}`] ?? ""}
                          env={env}
                          titlesByRef={titlesByRef}
                          onNavigate={onNavigate}
                          onChooseField={setTitleFieldFor}
                        />
                      ))}
                    </div>
                  )}

                  {/* Incoming: records that reference this one */}
                  {incoming.length > 0 && (
                    <div>
                      <div className="text-slate-500 font-semibold mb-0.5">
                        Referenced by <span className="font-normal text-slate-400">({incoming.length})</span>
                      </div>
                      {[...incomingByType.entries()].map(([refType, refs]) => (
                        <DepGroup
                          key={refType}
                          refType={refType}
                          refs={refs}
                          fields={fieldsByType[refType] ?? []}
                          chosen={titlePrefs[`${env}::${refType}`] ?? ""}
                          env={env}
                          titlesByRef={titlesByRef}
                          onNavigate={onNavigate}
                          onChooseField={setTitleFieldFor}
                          titleSuffix=" → this record"
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {type && id && record && depsRequested && !depsLoading && !hasDeps && (
        <div className="border-b border-slate-100 shrink-0 px-3 py-1.5 text-[11px] text-slate-400">
          No dependencies found.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {loading && <div className="p-3 text-xs text-slate-400">Loading…</div>}
        {!loading && type && id && record && (
          <JsonFileViewer
            key={`${env}:${type}:${id}`}
            content={content}
            fileName={`${id}.json`}
          />
        )}
        {!loading && type && id && !record && (
          <div className="p-3 text-xs text-rose-600">Record not found.</div>
        )}
      </div>
    </div>
  );
}
