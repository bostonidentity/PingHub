"use client";

import { useEffect, useRef, useState } from "react";
import { ConfigScope, CONFIG_SCOPES } from "@/lib/fr-config-types";
import { cn } from "@/lib/utils";

interface ScopeAudit {
  scope: string;
  fileCount: number;
  exists: boolean;
}

function scopeLabel(scope: string): string {
  return CONFIG_SCOPES.find((s) => s.value === scope)?.label ?? scope;
}

export function PushAudit({
  environment,
  scopes,
}: {
  environment: string;
  scopes: ConfigScope[];
}) {
  const [audit, setAudit] = useState<ScopeAudit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeKey = scopes.join(",");

  useEffect(() => {
    if (!scopes.length) {
      setAudit(null);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ environment, scopes: scopeKey });
        const res = await fetch(`/api/push/audit?${params}`);
        if (res.ok) setAudit(await res.json());
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment, scopeKey]);

  if (!scopes.length) return null;

  const totalFiles = audit?.reduce((s, a) => s + a.fileCount, 0) ?? 0;
  const emptyScopes = audit?.filter((a) => a.fileCount === 0) ?? [];

  return (
    <div className="rounded-md border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
        <span className="text-xs font-medium text-slate-600">Local files to push</span>
        {!loading && audit && (
          <span className="text-xs text-slate-400 tabular-nums">
            {totalFiles} file{totalFiles !== 1 ? "s" : ""} total
          </span>
        )}
      </div>

      {/* Scope rows */}
      <div className="divide-y divide-slate-100">
        {loading
          ? scopes.map((scope) => (
              <div key={scope} className="flex items-center gap-3 px-3 py-2 animate-pulse">
                <div className="w-2 h-2 rounded-full bg-slate-200 shrink-0" />
                <div className="h-2.5 flex-1 bg-slate-100 rounded" />
                <div className="h-2.5 w-10 bg-slate-100 rounded" />
              </div>
            ))
          : audit?.map((a) => (
              <div key={a.scope} className="flex items-center gap-3 px-3 py-1.5">
                <span
                  className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    a.fileCount > 0 ? "bg-emerald-400" : "bg-amber-400"
                  )}
                />
                <span className="flex-1 text-xs text-slate-700">{scopeLabel(a.scope)}</span>
                <span
                  className={cn(
                    "text-xs tabular-nums font-mono",
                    a.fileCount === 0 ? "text-amber-500" : "text-slate-400"
                  )}
                >
                  {a.fileCount === 0 ? "no files" : `${a.fileCount} file${a.fileCount !== 1 ? "s" : ""}`}
                </span>
              </div>
            ))}
      </div>

      {/* Warning for empty scopes */}
      {!loading && emptyScopes.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border-t border-amber-100 text-xs text-amber-700">
          <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            {emptyScopes.length === 1
              ? `${scopeLabel(emptyScopes[0].scope)} has no local files — this scope will likely be a no-op.`
              : `${emptyScopes.length} scopes have no local files and will likely be no-ops.`}
          </span>
        </div>
      )}
    </div>
  );
}
