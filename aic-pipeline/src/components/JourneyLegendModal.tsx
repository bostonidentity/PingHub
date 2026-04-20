"use client";

import { useState, useEffect } from "react";

interface Props {
  variant?: "normal" | "diff";
}

export function JourneyLegendModal({ variant = "normal" }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Show legend"
        className="bg-white border border-slate-200 rounded-lg shadow-md flex items-center gap-1.5 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 text-[11px]"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
        </svg>
        <span className="font-semibold">Legend</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <div
            className="relative bg-white border border-slate-200 rounded-lg shadow-2xl w-[min(680px,100%)] max-h-[calc(100vh-2rem)] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 sticky top-0 bg-white">
              <h3 className="text-sm font-semibold text-slate-700">
                {variant === "diff" ? "Journey Diff Legend" : "Journey Graph Legend"}
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                className="text-slate-400 hover:text-slate-600 rounded p-1 hover:bg-slate-100"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5 text-[11px] text-slate-600">
              {variant === "diff" && (
                <section className="sm:col-span-2 space-y-1.5">
                  <p className="font-semibold text-slate-500 text-[9px] uppercase tracking-wide">Diff Status</p>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-1.5">
                    <div className="flex items-center gap-2"><span className="w-4 h-3 rounded border border-emerald-400 bg-emerald-50 inline-block shrink-0" /><span>Added</span></div>
                    <div className="flex items-center gap-2"><span className="w-4 h-3 rounded border border-dashed border-red-400 bg-red-50 inline-block shrink-0" /><span>Removed</span></div>
                    <div className="flex items-center gap-2"><span className="w-4 h-3 rounded border border-amber-400 bg-amber-50 inline-block shrink-0" /><span>Modified</span></div>
                    <div className="flex items-center gap-2"><span className="w-4 h-3 rounded border border-slate-300 bg-white inline-block shrink-0" /><span>Unchanged</span></div>
                    <div className="flex items-center gap-2"><span className="w-4 h-3 rounded border border-dashed border-amber-300 bg-amber-50 inline-block shrink-0" /><span>Inner</span></div>
                  </div>
                </section>
              )}

              <section className="space-y-1.5">
                <p className="font-semibold text-slate-500 text-[9px] uppercase tracking-wide">Nodes</p>
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-emerald-500 inline-block shrink-0" />
                  <span>Start</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-emerald-50 border-2 border-emerald-400 inline-block shrink-0" />
                  <span>Success (terminal)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-red-50 border-2 border-red-400 inline-block shrink-0" />
                  <span>Failure (terminal)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-5 h-3.5 rounded border border-slate-300 bg-white inline-block shrink-0" />
                  <span>Step node</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-5 h-3.5 rounded border border-slate-300 bg-violet-50 inline-block shrink-0" />
                  <span>Script node <span className="text-slate-400">(ScriptedDecisionNode)</span></span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-5 h-3.5 rounded border border-slate-300 bg-amber-50 inline-block shrink-0" />
                  <span>Inner journey <span className="text-slate-400">(InnerTreeEvaluatorNode)</span></span>
                </div>
                {variant === "normal" && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-3.5 rounded border-2 border-violet-400 bg-violet-50 inline-block shrink-0" />
                      <span>Page group</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-3.5 rounded border border-dashed border-slate-400 bg-slate-50 inline-block shrink-0" />
                      <span>Folded chain (⋯ N&nbsp;steps)</span>
                    </div>
                  </>
                )}
              </section>

              <section className="space-y-1.5">
                <p className="font-semibold text-slate-500 text-[9px] uppercase tracking-wide">Edges</p>
                <div className="flex items-center gap-2"><span className="w-6 h-0.5 bg-slate-500 inline-block shrink-0" /><span>Transition</span></div>
                <div className="flex items-center gap-2"><span className="w-6 h-0.5 bg-emerald-400 inline-block shrink-0" /><span>→ Success</span></div>
                <div className="flex items-center gap-2"><span className="w-6 h-0.5 bg-red-400 inline-block shrink-0" /><span>→ Failure</span></div>
                {variant === "normal" && (
                  <>
                    <div className="flex items-center gap-2"><span className="w-6 h-0.5 bg-blue-500 inline-block shrink-0" /><span>Hover edge</span></div>
                    <div className="flex items-center gap-2"><span className="w-6 h-0.5 bg-violet-500 inline-block shrink-0" /><span>Pinned edge</span></div>
                  </>
                )}

                <p className="font-semibold text-slate-500 text-[9px] uppercase tracking-wide pt-3">Highlights</p>
                {variant === "normal" ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-3.5 rounded border border-sky-500 ring-2 ring-sky-300 inline-block shrink-0" />
                      <span>Selected node</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-3.5 rounded border border-amber-400 ring-2 ring-amber-200 inline-block shrink-0" />
                      <span>Search match</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-3.5 rounded border border-red-500 ring-2 ring-red-400 inline-block shrink-0" />
                      <span>Focused diff</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-3.5 rounded border border-amber-400 ring-2 ring-amber-400 inline-block shrink-0" />
                      <span>Search match</span>
                    </div>
                  </>
                )}
              </section>

              <section className="sm:col-span-2 space-y-1 border-t border-slate-100 pt-4 text-slate-500">
                <p className="font-semibold text-slate-500 text-[9px] uppercase tracking-wide">Tips</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-0.5">
                  {variant === "normal" ? (
                    <>
                      <p>Click node → trace path</p>
                      <p>Double-click inner journey → open it</p>
                      <p>Click folded chain → expand</p>
                      <p>Drag node → rearrange</p>
                    </>
                  ) : (
                    <>
                      <p>Click node → open details</p>
                      <p>Script/inner diffs show in side panel</p>
                      <p>Use Next/Prev to step through changes</p>
                      <p>Drag node → rearrange</p>
                    </>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
