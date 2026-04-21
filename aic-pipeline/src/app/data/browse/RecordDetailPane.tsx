// src/app/data/browse/RecordDetailPane.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { JsonFileViewer } from "@/components/JsonFileViewer";

export function RecordDetailPane({ env, type, id }: { env: string; type: string | null; id: string | null }) {
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!type || !id) return;
    let cancelled = false;
    // Flag the loading state before kicking off the fetch so the spinner
    // appears immediately; the disable is for a genuine async-loading case
    // the lint rule doesn't model.
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

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col min-h-[500px] max-h-[calc(100vh-280px)]">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2 text-xs text-slate-700 shrink-0">
        {type && id
          ? <><span className="font-mono">{type} / {id}</span></>
          : <span className="text-slate-400">Click a record to view details</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading && <div className="p-3 text-xs text-slate-400">Loading…</div>}
        {!loading && type && id && record && (
          // Remount the viewer whenever the selected record changes so its
          // internal expand/find/selection state resets cleanly.
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
