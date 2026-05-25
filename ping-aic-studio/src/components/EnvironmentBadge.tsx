import { cn } from "@/lib/utils";
import type { Environment } from "@/lib/fr-config";

const DOT: Record<string, string> = {
  blue:   "bg-blue-400",
  green:  "bg-emerald-400",
  yellow: "bg-amber-400",
  red:    "bg-rose-400",
  slate:  "bg-slate-400",
};

const BADGE: Record<string, string> = {
  blue:   "bg-blue-50 text-blue-700 ring-blue-200",
  green:  "bg-emerald-50 text-emerald-700 ring-emerald-200",
  yellow: "bg-amber-50 text-amber-700 ring-amber-200",
  red:    "bg-rose-50 text-rose-700 ring-rose-200",
  slate:  "bg-slate-50 text-slate-700 ring-slate-200",
};

export function EnvironmentBadge({
  env,
  showDot = true,
  className,
}: { env: Environment; showDot?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {showDot && (
        <span className={cn("w-2 h-2 rounded-full shrink-0", DOT[env.color] ?? DOT.slate)} />
      )}
      <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full ring-1", BADGE[env.color] ?? BADGE.slate)}>
        {env.label}
      </span>
    </span>
  );
}
