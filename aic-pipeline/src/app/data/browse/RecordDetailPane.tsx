// src/app/data/browse/RecordDetailPane.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { JsonFileViewer } from "@/components/JsonFileViewer";
import { cn } from "@/lib/utils";
import type { RefsResponse } from "@/app/api/data/refs/[env]/[type]/[id]/route";
import type { GlobalSearchResponse } from "@/app/api/data/search/[env]/route";

// ── Component ────────────────────────────────────────────────────────────────

export function RecordDetailPane({
  env, type, id, onNavigate,
}: {
  env: string;
  type: string | null;
  id: string | null;
  onNavigate?: (type: string, id: string) => void;
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

  // Reset deps when the selected record changes
  useEffect(() => {
    setOutgoing([]);
    setIncoming([]);
    setDepsRequested(false);
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
              {/* Outgoing: records this one references */}
              {outgoing.length > 0 && (
                <div>
                  <div className="text-slate-500 font-semibold mb-0.5">
                    References <span className="font-normal text-slate-400">({outgoing.length})</span>
                  </div>
                  {[...outgoingByType.entries()].map(([refType, refs]) => (
                    <div key={refType} className="ml-2 mb-1">
                      <span className="text-slate-400">{refType}</span>
                      <div className="ml-2 flex flex-wrap gap-x-2 gap-y-0.5">
                        {refs.map((r) => (
                          <button
                            key={`${r.type}:${r.id}`}
                            type="button"
                            onClick={() => onNavigate?.(r.type, r.id)}
                            title={`${r.type}/${r.id}`}
                            className="font-mono text-sky-600 hover:underline hover:text-sky-800 truncate max-w-[240px]"
                          >
                            {r.id}
                          </button>
                        ))}
                      </div>
                    </div>
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
                    <div key={refType} className="ml-2 mb-1">
                      <span className="text-slate-400">{refType}</span>
                      <div className="ml-2 flex flex-wrap gap-x-2 gap-y-0.5">
                        {refs.map((r) => (
                          <button
                            key={`${r.type}:${r.id}`}
                            type="button"
                            onClick={() => onNavigate?.(r.type, r.id)}
                            title={`${r.type}/${r.id} → this record`}
                            className="font-mono text-sky-600 hover:underline hover:text-sky-800 truncate max-w-[240px]"
                          >
                            {r.id}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
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
