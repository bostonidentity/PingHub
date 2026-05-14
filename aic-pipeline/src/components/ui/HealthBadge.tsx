import { StatusPill } from "@/components/ui/StatusPill";
import type { HealthCacheEntry } from "@/lib/health/types";

export type EnvHealthState = "healthy" | "stale" | "locked" | "error";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function healthTooltip(info: HealthCacheEntry | null | undefined): string {
  if (!info) return "";
  const when = timeAgo(info.checkedAt);
  const lat = typeof info.latencyMs === "number" ? ` (${info.latencyMs}ms)` : "";
  if (info.status === "healthy") return `tenant /monitoring/health OK${lat} \u2014 checked ${when}`;
  const reason = info.error ?? `HTTP ${info.httpStatus ?? "?"}`;
  return `tenant unhealthy: ${reason}${lat} \u2014 checked ${when}`;
}

export interface HealthBadgeProps {
  state: EnvHealthState;
  info?: HealthCacheEntry | null;
  /** Show the "checked Xm ago" line under the pill. */
  showTimestamp?: boolean;
  className?: string;
}

/**
 * Renders the tenant-health pill plus an optional "checked Xm ago" line,
 * using the cached probe entry for tooltip and timestamp.
 */
export function HealthBadge({ state, info, showTimestamp = true, className }: HealthBadgeProps) {
  const tooltip = healthTooltip(info);
  const pill =
    state === "healthy" ? <StatusPill tone="success" title={tooltip}>healthy</StatusPill>
      : state === "stale" ? <StatusPill tone="warning" title={tooltip || "tenant not yet probed"}>checking…</StatusPill>
        : state === "locked" ? <StatusPill tone="danger" title={tooltip}>locked</StatusPill>
          : <StatusPill tone="danger" title={tooltip || "unhealthy"}>unhealthy</StatusPill>;

  const checked = info?.checkedAt ? timeAgo(info.checkedAt) : null;

  return (
    <div className={`flex flex-col items-end gap-0.5 ${className ?? ""}`}>
      {pill}
      {showTimestamp && checked && (
        <span className="text-[10px] text-slate-400 leading-none" title={info?.checkedAt}>
          checked {checked}
        </span>
      )}
    </div>
  );
}
