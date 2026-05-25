import Link from "next/link";
import { getEnvironments } from "@/lib/fr-config";
import { readHistoryMerged } from "@/lib/op-history";
import type { HistoryRecord } from "@/lib/op-history";
import { EnvCard, type EnvHealth } from "@/components/EnvCard";
import { readReleaseInfo } from "@/lib/release/persistence";
import { classifyUpgrade, daysUntil } from "@/lib/release/urgency";
import type { ReleaseCacheEntry } from "@/lib/release/types";
import { triggerStaleRefreshAsync } from "@/lib/release/auto-refresh";
import { triggerStaleHealthRefreshAsync } from "@/lib/health/auto-refresh";
import { readHealthInfo } from "@/lib/health/persistence";
import type { HealthCacheEntry } from "@/lib/health/types";

// Always render fresh on each request — the env list / health / release caches
// can change underneath us (import, refresh, manual edits) and Next must not
// serve a stale RSC payload.
export const dynamic = "force-dynamic";

const DASHBOARD_BANNER_SOON_DAYS = 7;

function deriveHealth(
  health: HealthCacheEntry | null,
  lastPull: HistoryRecord | null,
  lastPush: HistoryRecord | null,
): EnvHealth {
  // Tenant reachability is the primary signal.
  if (health?.status === "unhealthy") return "error";
  if (!health) return "stale";
  // When the tenant is healthy, surface a sync-status warning if the most
  // recent operation failed — distinct from tenant being down.
  if (lastPull?.status === "failed" || lastPush?.status === "failed") return "error";
  return "healthy";
}

export default function DashboardPage() {
  triggerStaleRefreshAsync();
  triggerStaleHealthRefreshAsync();
  const environments = getEnvironments();
  const history = readHistoryMerged({ limit: 500 }).filter((r) => r.type !== "log-search");

  const envCards = environments.map((env) => {
    const lastPull = history.find((r) => r.type === "pull" && r.environment === env.name) ?? null;
    const lastPush = history.find((r) => r.type === "push" && r.environment === env.name) ?? null;
    const health = readHealthInfo(env.name);
    return {
      env,
      health: deriveHealth(health, lastPull, lastPush),
      healthInfo: health,
      lastPull: lastPull && { at: lastPull.completedAt, status: lastPull.status, scopes: lastPull.scopes },
      lastPush: lastPush && { at: lastPush.completedAt, status: lastPush.status, scopes: lastPush.scopes },
      release: readReleaseInfo(env.name),
    };
  });

  const upcomingUpgrades: UpgradeItem[] = envCards.flatMap(({ env, release }) => {
    const nextUpgrade = release?.info?.nextUpgrade ?? null;
    const urgency = classifyUpgrade(nextUpgrade, undefined, { soonDays: DASHBOARD_BANNER_SOON_DAYS });
    if (urgency !== "soon" && urgency !== "overdue") return [];
    return [{ env, release, urgency, days: daysUntil(nextUpgrade) }];
  });

  return (
    <div className="space-y-10">
      <header>
        <h1 className="page-title">Dashboard</h1>
        <p className="section-subtitle mt-1">
          Manage your Ping Advanced Identity Cloud configuration pipeline.
        </p>
      </header>

      {upcomingUpgrades.length > 0 && <UpcomingUpgradesBanner items={upcomingUpgrades} />}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="section-title">Environments</h2>
          <Link href="/environments" className="text-sm text-indigo-600 hover:text-indigo-700">Manage →</Link>
        </div>
        {envCards.length === 0 ? (
          <div className="card-padded text-center text-sm text-slate-400">
            No environments configured.{" "}
            <Link href="/environments" className="text-indigo-600 hover:underline">Add one</Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {envCards.map(({ env, health, healthInfo, lastPull, lastPush, release }) => (
              <EnvCard
                key={env.name}
                env={env}
                health={health}
                healthInfo={healthInfo}
                lastPull={lastPull ?? null}
                lastPush={lastPush ?? null}
                release={release as ReleaseCacheEntry | null}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface UpgradeItem {
  env: { name: string; label: string };
  release: ReleaseCacheEntry | null;
  urgency: "soon" | "overdue";
  days: number | null;
}

function UpcomingUpgradesBanner({ items }: { items: UpgradeItem[] }) {
  const hasOverdue = items.some((x) => x.urgency === "overdue");
  const tone = hasOverdue
    ? "bg-rose-50 border-rose-200 text-rose-800"
    : "bg-amber-50 border-amber-200 text-amber-800";
  return (
    <div className={`border rounded-lg px-4 py-3 text-sm ${tone}`}>
      <div className="font-semibold mb-1">Upcoming AIC upgrades</div>
      <ul className="space-y-0.5">
        {items.map((x) => (
          <li key={x.env.name} className="flex items-baseline gap-2">
            <span className="font-medium">{x.env.label}</span>
            <span className="text-xs opacity-75">({x.env.name})</span>
            <span className="text-xs">·</span>
            <span className="text-xs">
              {x.urgency === "overdue"
                ? x.days !== null
                  ? `overdue by ${Math.abs(x.days)}d`
                  : "overdue"
                : x.days !== null
                  ? `in ${x.days}d`
                  : "soon"}
            </span>
            {x.release?.info?.nextUpgrade && (
              <span className="text-xs opacity-75" title={x.release.info.nextUpgrade}>
                (planned {formatPlannedDate(x.release.info.nextUpgrade)})
              </span>
            )}
            {x.release?.info?.currentVersion && (
              <span className="text-xs font-mono opacity-75">v{x.release.info.currentVersion} → ?</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatPlannedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
