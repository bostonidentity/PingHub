"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { AuditItem } from "@/app/api/push/audit/route";

interface AuditEntry {
  scope: string;
  fileCount: number;
  exists: boolean;
  items: AuditItem[];
  selectable: boolean;
}

/** A clickable "N scopes" badge that opens the last-pull details modal. */
export function ScopesBadge({
  env,
  scopes,
  timestamp,
  className,
}: {
  env: string;
  scopes: string[];
  timestamp: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (scopes.length === 0) {
    return (
      <span className={cn("text-slate-400", className)}>
        0 scopes
      </span>
    );
  }
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
        className={cn(
          "text-sky-600 hover:text-sky-800 hover:underline cursor-pointer",
          className,
        )}
        title="View scopes and items pulled"
      >
        {scopes.length} scope{scopes.length !== 1 ? "s" : ""}
      </span>
      <LastPullModal
        open={open}
        env={env}
        scopes={scopes}
        timestamp={timestamp}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function LastPullModal({
  open,
  env,
  scopes,
  timestamp,
  onClose,
}: {
  open: boolean;
  env: string;
  scopes: string[];
  timestamp: string;
  onClose: () => void;
}) {
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || scopes.length === 0) {
      setAudit(null);
      setError(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ environment: env, scopes: scopes.join(",") });
    fetch(`/api/push/audit?${params}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((data) => setAudit(data as AuditEntry[]))
      .catch((e) => { if (e?.name !== "AbortError") setError(e?.message ?? "Failed to load items"); })
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [open, env, scopes]);

  const formatted = (() => {
    try { return new Date(timestamp).toLocaleString(); } catch { return timestamp; }
  })();

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/30 z-40" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90vw] max-w-2xl max-h-[80vh] bg-white rounded-lg shadow-xl z-50 flex flex-col overflow-hidden"
          onPointerDownOutside={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-3 border-b border-slate-200 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-slate-800 truncate">
                Last pull · {env}
              </Dialog.Title>
              <Dialog.Description className="text-xs text-slate-500 mt-0.5">
                {formatted} · {scopes.length} scope{scopes.length !== 1 ? "s" : ""}
              </Dialog.Description>
            </div>
            <Dialog.Close className="text-slate-400 hover:text-slate-700 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {loading && <div className="text-xs text-slate-500">Loading items…</div>}
            {error && <div className="text-xs text-rose-600">{error}</div>}
            {audit && (
              <div className="space-y-2">
                {audit.map((entry) => (
                  <ScopeSection key={entry.scope} env={env} entry={entry} />
                ))}
                {audit.length === 0 && (
                  <div className="text-xs text-slate-400 italic">No scope audit returned.</div>
                )}
              </div>
            )}
            <p className="mt-3 text-[10px] text-slate-400">
              Items reflect the current on-disk state for this environment. If you&rsquo;ve pulled
              or edited since the last run, what you see here may differ from what the pull
              originally wrote.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ScopeSection({ env, entry }: { env: string; entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const itemCount = entry.items.length;
  return (
    <div className="border border-slate-200 rounded overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50/60">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:text-slate-900"
          disabled={itemCount === 0}
        >
          <svg
            className={cn(
              "w-3 h-3 text-slate-400 transition-transform shrink-0",
              expanded ? "rotate-0" : "-rotate-90",
              itemCount === 0 && "opacity-30",
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          <span className="text-xs font-medium text-slate-700 truncate">{entry.scope}</span>
          <span className="text-[10px] text-slate-400 shrink-0">
            {itemCount} item{itemCount !== 1 ? "s" : ""}
            {entry.fileCount !== itemCount && ` · ${entry.fileCount} file${entry.fileCount !== 1 ? "s" : ""}`}
          </span>
        </button>
        <a
          href={`/configs?env=${encodeURIComponent(env)}&scope=${encodeURIComponent(entry.scope)}`}
          target="_blank"
          rel="noopener"
          className="text-[11px] text-sky-600 hover:text-sky-800 hover:underline shrink-0"
          onClick={(e) => e.stopPropagation()}
          title="Open this scope in the Browse tab"
        >
          Find in Browse ↗
        </a>
      </div>
      {expanded && itemCount > 0 && (
        <ul className="px-3 py-2 border-t border-slate-100 space-y-0.5 max-h-48 overflow-y-auto">
          {entry.items.map((item) => (
            <li key={item.id} className="text-[11px] font-mono text-slate-600 truncate" title={item.id}>
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
