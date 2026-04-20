import { cn } from "@/lib/utils";
import type { HistoryRecord } from "@/lib/op-history";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  pull:       { label: "PL",  bg: "bg-indigo-50",  fg: "text-indigo-700"  },
  push:       { label: "PS",  bg: "bg-emerald-50", fg: "text-emerald-700" },
  promote:    { label: "PR",  bg: "bg-amber-50",   fg: "text-amber-700"   },
  compare:    { label: "CMP", bg: "bg-violet-50",  fg: "text-violet-700"  },
  "dry-run":  { label: "DR",  bg: "bg-fuchsia-50", fg: "text-fuchsia-700" },
};

function label(r: HistoryRecord): string {
  if (r.type === "compare" || r.type === "dry-run") {
    const src = r.source?.environment ?? r.environment;
    const tgt = r.target?.environment ?? "—";
    return `${src} → ${tgt}`;
  }
  return r.environment;
}

export function ActivityRow({ record, onClick }: { record: HistoryRecord; onClick?: () => void }) {
  const chip = CHIP[record.type] ?? { label: "OP", bg: "bg-slate-100", fg: "text-slate-600" };
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
    >
      <span className={cn("w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0", chip.bg, chip.fg)}>
        {chip.label}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px]">
          <span className="font-medium capitalize">{record.type}</span>
          <span className="text-slate-500"> · {label(record)}</span>
        </div>
        {record.scopes.length > 0 && (
          <div className="text-[11px] text-slate-400 truncate">
            {record.scopes.slice(0, 4).join(", ")}{record.scopes.length > 4 ? ` +${record.scopes.length - 4}` : ""}
          </div>
        )}
      </div>
      <div className="text-[11px] text-slate-400">{timeAgo(record.completedAt)}</div>
      <span className={cn("w-1.5 h-1.5 rounded-full", record.status === "success" ? "bg-emerald-400" : "bg-rose-400")} />
    </button>
  );
}
