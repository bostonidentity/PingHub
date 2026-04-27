// src/app/data/browse/RecordDetailPane.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { JsonFileViewer } from "@/components/JsonFileViewer";
import { cn } from "@/lib/utils";
import type { GlobalSearchResponse } from "@/app/api/data/search/[env]/route";

// ── Ref extraction ───────────────────────────────────────────────────────────

interface ManagedRef {
  /** JSON path where the _ref was found, e.g. "roles[0]" */
  path: string;
  type: string;
  id: string;
}

/** Recursively walk an object and collect every `_ref` that matches `managed/{type}/{id}`. */
function extractOutgoingRefs(obj: unknown, prefix = ""): ManagedRef[] {
  const refs: ManagedRef[] = [];
  if (obj == null || typeof obj !== "object") return refs;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => refs.push(...extractOutgoingRefs(item, `${prefix}[${i}]`)));
    return refs;
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec._ref === "string") {
    const m = rec._ref.match(/^managed\/([^/]+)\/(.+)$/);
    if (m) refs.push({ path: prefix || "(root)", type: m[1], id: m[2] });
  }
  for (const [key, val] of Object.entries(rec)) {
    if (key === "_ref") continue;
    refs.push(...extractOutgoingRefs(val, prefix ? `${prefix}.${key}` : key));
  }
  return refs;
}

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

  // ── Outgoing refs ────────────────────────────────────────────────────────
  const outgoing = useMemo(() => (record ? extractOutgoingRefs(record) : []), [record]);

  // ── Incoming refs (records that reference this one) ──────────────────────
  const [incoming, setIncoming] = useState<{ type: string; id: string }[]>([]);
  const [incomingLoading, setIncomingLoading] = useState(false);
  const [incomingTruncated, setIncomingTruncated] = useState(false);

  useEffect(() => {
    if (!type || !id) { setIncoming([]); return; }
    let cancelled = false;
    setIncomingLoading(true);
    const needle = `managed/${type}/${id}`;
    const params = new URLSearchParams({ q: needle, limit: "100" });
    fetch(`/api/data/search/${env}?${params.toString()}`)
      .then((r) => r.ok ? r.json() : { hits: [], truncated: false })
      .then((d: GlobalSearchResponse) => {
        if (cancelled) return;
        // Exclude the current record itself from the results.
        const hits = d.hits.filter((h) => !(h.type === type && h.id === id));
        setIncoming(hits.map((h) => ({ type: h.type, id: h.id })));
        setIncomingTruncated(d.truncated);
      })
      .catch(() => { if (!cancelled) setIncoming([]); })
      .finally(() => { if (!cancelled) setIncomingLoading(false); });
    return () => { cancelled = true; };
  }, [env, type, id]);

  // Group outgoing by type for display
  const outgoingByType = useMemo(() => {
    const m = new Map<string, ManagedRef[]>();
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

  const hasDeps = outgoing.length > 0 || incoming.length > 0 || incomingLoading;

  // ── Deps panel open/closed ───────────────────────────────────────────────
  const [depsOpen, setDepsOpen] = useState(true);

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col h-full">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2 text-xs text-slate-700 shrink-0">
        {type && id
          ? <><span className="font-mono">{type} / {id}</span></>
          : <span className="text-slate-400">Click a record to view details</span>}
      </div>

      {/* Dependencies panel */}
      {type && id && record && hasDeps && (
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
              ({outgoing.length} outgoing{incomingLoading ? "" : `, ${incoming.length} incoming`})
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
                            title={`${r.path} → ${r.type}/${r.id}`}
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
              {(incoming.length > 0 || incomingLoading) && (
                <div>
                  <div className="text-slate-500 font-semibold mb-0.5">
                    Referenced by{" "}
                    {incomingLoading
                      ? <span className="font-normal text-slate-400">loading…</span>
                      : <span className="font-normal text-slate-400">({incoming.length}{incomingTruncated ? "+" : ""})</span>}
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
