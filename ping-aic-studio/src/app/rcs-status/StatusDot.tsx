import { cn } from "@/lib/utils";
import type { Overall } from "@/lib/rcs/types";

const DOT: Record<Overall, string> = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-rose-500",
  empty: "bg-slate-300",
};

const RING: Record<Overall, string> = {
  ok: "ring-emerald-200",
  degraded: "ring-amber-200",
  down: "ring-rose-200",
  empty: "ring-slate-200",
};

export function StatusDot({ overall, className }: { overall: Overall; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block w-2.5 h-2.5 rounded-full ring-2",
        DOT[overall],
        RING[overall],
        className,
      )}
    />
  );
}
