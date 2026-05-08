"use client";
import { useEffect, useState } from "react";
import type { Category } from "@/lib/managed-object-usage";

type Hit = {
  category: Category; filePath: string; line: number; column: number;
  snippet: string; fieldName: string | null; realmRoot: string | null;
  isSelfReference: boolean;
};

type UsageResponse = {
  scanned: { files: number; bytes: number; ms: number; skipped: number; errors: number };
  truncated: boolean;
  hits: Hit[];
  counts: { byCategory: Partial<Record<Category, number>> };
};

const CATEGORY_LABEL: Record<Category, string> = {
  "journey": "Journey",
  "script-library": "Script library",
  "script-library-config": "Script library (config)",
  "custom-endpoint": "Custom endpoint",
  "workflow": "Workflow",
  "iga-assignment": "IGA assignment",
  "iga-form": "IGA form",
  "managed-object-config": "Managed-object config",
  "sync-mapping": "Sync mapping",
  "scheduler": "Scheduler",
  "internal-role": "Internal role",
  "access-config": "Access config",
  "connector-agent": "Connector / agent",
  "other": "Other",
};

const CATEGORY_ORDER: Category[] = [
  "journey", "script-library", "script-library-config",
  "custom-endpoint", "workflow", "iga-assignment", "iga-form",
  "managed-object-config", "sync-mapping", "scheduler",
  "internal-role", "access-config", "connector-agent", "other",
];

export function ManagedObjectUsagePanel({
  env, type, onClose,
}: { env: string; type: string; onClose: () => void }) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<Category>>(new Set(CATEGORY_ORDER.filter(c => c !== "other")));

  useEffect(() => {
    const ctl = new AbortController();
    setData(null);
    setError(null);
    const params = new URLSearchParams({ env, type });
    fetch(`/api/analyze/managed-object-usage?${params}`, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<UsageResponse>;
      })
      .then((d) => setData(d))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(String(e?.message ?? e));
      });
    return () => ctl.abort();
  }, [env, type]);

  const toggle = (c: Category) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Find usage of &quot;{type}&quot;</div>
        <button
          type="button"
          aria-label="close"
          className="text-slate-400 hover:text-slate-200"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {!data && !error && <p className="text-xs text-slate-400">Searching…</p>}
      {error && <p className="text-xs text-red-400">Error: {error}</p>}
      {data && (
        <>
          <p className="text-[10px] text-slate-500 mb-2">
            Scanned {data.scanned.files.toLocaleString()} files · {data.hits.length} hits
          </p>
          {data.truncated && (
            <p className="text-xs text-amber-400 mb-2">
              Showing first 2,000 hits — additional results were not loaded.
            </p>
          )}
          {data.hits.length === 0 && (
            <p className="text-xs text-slate-400 italic">No usages found in this environment.</p>
          )}
          {CATEGORY_ORDER.map((cat) => {
            const count = data.counts.byCategory[cat] ?? 0;
            if (count === 0) return null;
            const isOpen = open.has(cat);
            return (
              <div key={cat} className="mb-2">
                <button
                  type="button"
                  onClick={() => toggle(cat)}
                  aria-expanded={isOpen}
                  className="text-xs font-medium text-sky-400 hover:text-sky-300 hover:underline"
                >
                  {isOpen ? "▾" : "▸"} {CATEGORY_LABEL[cat]} ({count})
                </button>
                {isOpen && (
                  <ul className="mt-1 ml-4 space-y-1">
                    {data.hits.filter(h => h.category === cat).map((h, i) => (
                      <li key={i} className="text-xs">
                        <div className="text-sky-400 font-mono">{h.filePath}</div>
                        <div className="text-slate-500">
                          line {h.line}
                          {h.fieldName && <> · field: {h.fieldName}</>}
                          {h.isSelfReference && <span className="ml-1 px-1 bg-slate-700 text-slate-300 rounded text-[10px]">self / hooks</span>}
                        </div>
                        <div className="font-mono text-slate-400 truncate">{h.snippet}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
