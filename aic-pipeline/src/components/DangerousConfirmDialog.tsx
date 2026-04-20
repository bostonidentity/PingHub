"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiffSummary } from "@/lib/fr-config";
import { formatScopeLabel } from "@/lib/compare";

interface Props {
  open: boolean;
  title: string;
  subtitle: string;
  tenantName: string;
  requireTypeToConfirm: boolean;
  blockUntilDiffLoaded: boolean;
  diffLoader: () => Promise<DiffSummary[]>;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DangerousConfirmDialog(props: Props) {
  const {
    open,
    title,
    subtitle,
    tenantName,
    requireTypeToConfirm,
    blockUntilDiffLoaded,
    diffLoader,
    onConfirm,
    onCancel,
  } = props;
  const [typed, setTyped] = useState("");
  const [diff, setDiff] = useState<DiffSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipDiff, setSkipDiff] = useState(false);
  const [showSkipLink, setShowSkipLink] = useState(false);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setDiff(null);
      setError(null);
      setSkipDiff(false);
      setShowSkipLink(false);
      return;
    }
    let cancelled = false;
    diffLoader()
      .then((d) => { if (!cancelled) setDiff(d); })
      .catch((e) => { if (!cancelled) setError(e.message ?? "diff failed"); });
    return () => { cancelled = true; };
  }, [open, diffLoader]);

  useEffect(() => {
    if (!open || blockUntilDiffLoaded || diff || error) return;
    const timer = window.setTimeout(() => setShowSkipLink(true), 3000);
    return () => window.clearTimeout(timer);
  }, [open, blockUntilDiffLoaded, diff, error]);

  const typeMatches = typed === tenantName;
  const diffReady = diff !== null || error !== null;
  const typeGateOk = requireTypeToConfirm ? typeMatches : true;
  const diffGateOk = blockUntilDiffLoaded ? diffReady : true;
  const canConfirm = typeGateOk && diffGateOk;

  const totalChanges = diff
    ? diff.reduce((n, r) => n + r.added + r.modified + r.removed, 0)
    : 0;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/55 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(560px,calc(100vw-32px))] bg-white rounded-2xl shadow-2xl overflow-hidden">
          <div className="flex items-start gap-4 p-5 border-b border-slate-100">
            <div className="w-10 h-10 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <Dialog.Title className="text-[16px] font-bold text-slate-900">{title}</Dialog.Title>
              <Dialog.Description className="text-[12px] text-slate-500 mt-1">{subtitle}</Dialog.Description>
            </div>
            <button onClick={onCancel} aria-label="close" className="text-slate-400 hover:text-slate-600">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="label-xs">DIFF PREVIEW</span>
              {diff && (
                <span className="text-[11px] text-slate-400">
                  {diff.length} scope{diff.length === 1 ? "" : "s"} · {totalChanges} change{totalChanges === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {error && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-[12px] px-3 py-2">
                Diff unavailable — proceed with caution. ({error})
              </div>
            )}

            {!error && !diff && !skipDiff && (
              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-500 text-[12px] px-3 py-3 flex items-center justify-between">
                <span>Loading diff…</span>
                {showSkipLink && !blockUntilDiffLoaded && (
                  <button
                    type="button"
                    onClick={() => setSkipDiff(true)}
                    className="text-indigo-600 hover:text-indigo-700 text-[12px]"
                  >
                    Skip diff
                  </button>
                )}
              </div>
            )}

            {diff && diff.length > 0 && (
              <div className="border border-slate-200 rounded-lg max-h-48 overflow-y-auto mb-4">
                {diff.map((row) => (
                  <div
                    key={row.scope}
                    className="flex items-center gap-3 px-3.5 py-2.5 text-[12px] border-b border-slate-100 last:border-b-0"
                  >
                    <span className="flex-1 font-medium text-slate-800">{formatScopeLabel(row.scope)}</span>
                    <span className="text-emerald-700">+{row.added} new</span>
                    <span className="text-amber-700">~{row.modified} modified</span>
                    <span className="text-rose-700">−{row.removed} removed</span>
                  </div>
                ))}
              </div>
            )}

            {requireTypeToConfirm && (
              <>
                <label className="block text-[12px] text-slate-600 mb-2">
                  Type{" "}
                  <span className="font-mono bg-rose-50 text-rose-700 px-1.5 py-0.5 rounded font-semibold">
                    {tenantName}
                  </span>{" "}
                  to confirm
                </label>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={`type ${tenantName}`}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 font-mono text-[13px] text-slate-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 px-5 py-4 bg-slate-50 border-t border-slate-100">
            <button onClick={onCancel} className="btn-secondary">Cancel</button>
            <button
              onClick={onConfirm}
              disabled={!canConfirm}
              className={cn("btn-danger-solid", !canConfirm && "opacity-50 cursor-not-allowed")}
            >
              Confirm
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
