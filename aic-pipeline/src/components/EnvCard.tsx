import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/ui/StatusPill";
import { ScopesBadge } from "@/components/LastPullModal";
import type { Environment } from "@/lib/fr-config";

export type EnvHealth = "healthy" | "stale" | "locked" | "error";

export interface EnvCardProps {
  env: Environment & { baseUrl?: string };
  health: EnvHealth;
  lastPull: { at: string; status: "success" | "failed"; scopes?: string[] } | null;
  lastPush: { at: string; status: "success" | "failed"; scopes?: string[] } | null;
  onClick?: () => void;
}

const DOT: Record<string, string> = {
  blue:   "bg-blue-400",
  green:  "bg-emerald-400",
  yellow: "bg-amber-400",
  red:    "bg-rose-400",
  slate:  "bg-slate-400",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)   return "just now";
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function EnvCard({ env, health, lastPull, lastPush, onClick }: EnvCardProps) {
  const pill =
    health === "healthy" ? <StatusPill tone="success">healthy</StatusPill>
    : health === "stale" ? <StatusPill tone="warning">stale</StatusPill>
    : health === "locked" ? <StatusPill tone="danger">locked</StatusPill>
    : <StatusPill tone="danger">error</StatusPill>;

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className={cn(
        "card-padded text-left transition-shadow hover:shadow-[0_2px_8px_rgba(15,23,42,0.06)]",
        onClick && "cursor-pointer",
        health === "error" && "border-rose-200"
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={cn("w-2 h-2 rounded-full shrink-0", DOT[env.color] ?? DOT.slate)} />
          <span className="font-semibold text-[14px] text-slate-900">{env.label}</span>
        </div>
        {pill}
      </div>
      {env.baseUrl && (
        <div className="text-[11px] text-slate-500 font-mono truncate mb-3">{env.baseUrl}</div>
      )}
      <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px]">
        <div className="min-w-0">
          <div className="text-slate-400">Last pull</div>
          <div className={cn("font-medium", lastPull?.status === "failed" ? "text-rose-600" : "text-slate-700")}>
            {lastPull ? timeAgo(lastPull.at) : "—"}
          </div>
          {lastPull && lastPull.scopes && lastPull.scopes.length > 0 && (
            <div className="text-[10px] truncate">
              <ScopesBadge env={env.name} scopes={lastPull.scopes} timestamp={lastPull.at} />
            </div>
          )}
        </div>
        <div className="text-right min-w-0">
          <div className="text-slate-400">Last push</div>
          <div className={cn("font-medium", lastPush?.status === "failed" ? "text-rose-600" : "text-slate-700")}>
            {lastPush ? timeAgo(lastPush.at) : "—"}
          </div>
          {lastPush && lastPush.scopes && lastPush.scopes.length > 0 && (
            <div
              className="text-[10px] text-slate-500 truncate"
              title={lastPush.scopes.join(", ")}
            >
              {lastPush.scopes.length} scope{lastPush.scopes.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
