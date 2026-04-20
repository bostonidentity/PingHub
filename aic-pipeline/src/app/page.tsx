import Link from "next/link";
import { getEnvironments } from "@/lib/fr-config";
import { readHistoryMerged } from "@/lib/op-history";
import type { HistoryRecord } from "@/lib/op-history";
import { EnvCard, type EnvHealth } from "@/components/EnvCard";
import { ActivityRow } from "@/components/ActivityRow";

function deriveHealth(
  lastPull: HistoryRecord | null,
  lastPush: HistoryRecord | null,
): EnvHealth {
  const latest = [lastPull, lastPush].filter(Boolean) as HistoryRecord[];
  if (latest.some((r) => r.status === "failed")) return "error";
  const mostRecent = latest.sort((a, b) => +new Date(b.completedAt) - +new Date(a.completedAt))[0];
  if (!mostRecent) return "stale";
  const age = Date.now() - +new Date(mostRecent.completedAt);
  const DAY = 86_400_000;
  if (age > 7 * DAY) return "stale";
  return "healthy";
}

export default function DashboardPage() {
  const environments = getEnvironments();
  const history = readHistoryMerged({ limit: 500 }).filter((r) => r.type !== "log-search");

  const envCards = environments.map((env) => {
    const lastPull = history.find((r) => r.type === "pull" && r.environment === env.name) ?? null;
    const lastPush = history.find((r) => r.type === "push" && r.environment === env.name) ?? null;
    return {
      env,
      health: deriveHealth(lastPull, lastPush),
      lastPull: lastPull && { at: lastPull.completedAt, status: lastPull.status, scopes: lastPull.scopes },
      lastPush: lastPush && { at: lastPush.completedAt, status: lastPush.status, scopes: lastPush.scopes },
    };
  });

  const recent = history.slice(0, 8);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="page-title">Dashboard</h1>
        <p className="section-subtitle mt-1">
          Manage your Ping Advanced Identity Cloud configuration pipeline.
        </p>
      </header>

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
            {envCards.map(({ env, health, lastPull, lastPush }) => (
              <EnvCard
                key={env.name}
                env={env as any}
                health={health}
                lastPull={lastPull ?? null}
                lastPush={lastPush ?? null}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="section-title">Recent activity</h2>
          <Link href="/history" className="text-sm text-indigo-600 hover:text-indigo-700">View all →</Link>
        </div>
        <div className="card divide-y divide-slate-100">
          {recent.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400">No activity yet.</p>
          ) : (
            recent.map((r) => <ActivityRow key={r.id} record={r} />)
          )}
        </div>
      </section>
    </div>
  );
}
