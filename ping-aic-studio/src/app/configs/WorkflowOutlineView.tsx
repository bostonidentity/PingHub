"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { WorkflowStepKind } from "@/lib/workflow-graph";

type DiffStatus = "added" | "removed" | "modified" | "unchanged";

interface DiffStep {
  id: string;
  displayName: string;
  kind: WorkflowStepKind;
  diffStatus: DiffStatus;
}

interface WorkflowOutlineViewProps {
  steps: DiffStep[];
  onNavigate: (stepId: string) => void;
}

const STATUS_ORDER: DiffStatus[] = ["added", "modified", "removed", "unchanged"];

const STATUS_LABEL: Record<DiffStatus, string> = {
  added:     "Added",
  modified:  "Modified",
  removed:   "Removed",
  unchanged: "Unchanged",
};

const STATUS_BADGE: Record<DiffStatus, string> = {
  added:     "bg-emerald-100 text-emerald-700",
  modified:  "bg-amber-100 text-amber-700",
  removed:   "bg-red-100 text-red-700",
  unchanged: "bg-slate-100 text-slate-500",
};

const KIND_LABEL: Record<WorkflowStepKind, string> = {
  approvalTask:     "Approval",
  scriptTask:       "Script",
  exclusiveGateway: "Gateway",
};

export function WorkflowOutlineView({ steps, onNavigate }: WorkflowOutlineViewProps) {
  const grouped = useMemo(() => {
    const g: Record<DiffStatus, DiffStep[]> = { added: [], modified: [], removed: [], unchanged: [] };
    for (const s of steps) g[s.diffStatus].push(s);
    return g;
  }, [steps]);

  return (
    <div className="h-full overflow-auto bg-white text-[12px]">
      {STATUS_ORDER.map((status) => {
        const items = grouped[status];
        if (items.length === 0) return null;
        return (
          <section key={status} className="border-b border-slate-100 last:border-b-0">
            <header className="sticky top-0 bg-slate-50 px-3 py-1.5 flex items-center gap-2 border-b border-slate-100">
              <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded", STATUS_BADGE[status])}>
                {STATUS_LABEL[status]}
              </span>
              <span className="text-[10px] text-slate-400">{items.length}</span>
            </header>
            <ul>
              {items.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-label={`${STATUS_LABEL[status]} ${KIND_LABEL[s.kind]}: ${s.displayName}`}
                    onClick={() => onNavigate(s.id)}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-slate-50 transition-colors"
                  >
                    <span className="text-[10px] text-slate-400 w-16 shrink-0">{KIND_LABEL[s.kind]}</span>
                    <span className="flex-1 text-slate-700 truncate">{s.displayName}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {steps.length === 0 && (
        <p className="px-3 py-4 text-[11px] text-slate-400 italic">No steps</p>
      )}
    </div>
  );
}
