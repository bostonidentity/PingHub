import { Suspense } from "react";
import { getEnvironments } from "@/lib/fr-config";
import { readHistoryMerged } from "@/lib/op-history";
import { SyncForm } from "./SyncForm";

export default function SyncPage() {
  const environments = getEnvironments();
  const history = readHistoryMerged({ type: "pull", limit: 500 });
  // Build last-pull map: env name → { completedAt, scopes from that pull }.
  const lastPullMap: Record<string, { at: string; scopes: string[] }> = {};
  for (const r of history) {
    if (r.type === "pull" && r.environment && !lastPullMap[r.environment]) {
      lastPullMap[r.environment] = { at: r.completedAt, scopes: r.scopes };
    }
  }
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Sync</h1>
        <p className="section-subtitle mt-1">
          Pull config from your tenants into this repo.
        </p>
      </header>
      <Suspense fallback={<div className="card-padded text-slate-400">Loading…</div>}>
        <SyncForm environments={environments} lastPullMap={lastPullMap} />
      </Suspense>
    </div>
  );
}
