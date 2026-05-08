"use client";
import { useEffect, useState } from "react";

type Category =
  | "journey" | "script-library" | "script-library-config"
  | "custom-endpoint" | "workflow" | "iga-assignment" | "iga-form"
  | "managed-object-config" | "sync-mapping" | "scheduler"
  | "internal-role" | "access-config" | "connector-agent" | "other";

type Hit = {
  category: Category; filePath: string; line: number; column: number;
  snippet: string; fieldName: string | null; realmRoot: string | null;
  isSelfReference: boolean;
};

type Response = {
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
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<Category>>(new Set(CATEGORY_ORDER.filter(c => c !== "other")));

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const params = new URLSearchParams({ env, type });
    fetch(`/api/analyze/managed-object-usage?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Response>;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [env, type]);

  const toggle = (c: Category) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  return (
    <div className="border border-violet-200 rounded bg-violet-50 p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-violet-900">Find usage of &quot;{type}&quot;</div>
        <button
          type="button"
          aria-label="close"
          className="text-violet-700 hover:text-violet-900"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {!data && !error && <p className="text-slate-500 italic">Searching…</p>}
      {error && <p className="text-red-600">Error: {error}</p>}
      {data && (
        <>
          <p className="text-xs text-slate-600 mb-2">
            Scanned {data.scanned.files.toLocaleString()} files · {data.hits.length} hits
          </p>
          {data.truncated && (
            <p className="text-xs text-amber-700 mb-2">
              Showing first 2,000 hits — additional results were not loaded.
            </p>
          )}
          {data.hits.length === 0 && (
            <p className="text-slate-500 italic">No usages found in this environment.</p>
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
                  className="font-medium text-violet-800 hover:underline"
                >
                  {isOpen ? "▾" : "▸"} {CATEGORY_LABEL[cat]} ({count})
                </button>
                {isOpen && (
                  <ul className="mt-1 ml-4 space-y-1">
                    {data.hits.filter(h => h.category === cat).map((h, i) => (
                      <li key={i} className="text-xs">
                        <div className="text-violet-700 font-mono">{h.filePath}</div>
                        <div className="text-slate-500">
                          line {h.line}
                          {h.fieldName && <> · field: {h.fieldName}</>}
                          {h.isSelfReference && <span className="ml-1 px-1 bg-violet-200 rounded text-[10px]">self / hooks</span>}
                        </div>
                        <div className="font-mono text-slate-700 truncate">{h.snippet}</div>
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
