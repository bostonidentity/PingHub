import { getEnvironments } from "@/lib/fr-config";
import { triggerStaleRefreshAsync } from "@/lib/release/auto-refresh";
import { EnvironmentsManager } from "./EnvironmentsManager";

export default function EnvironmentsPage() {
  triggerStaleRefreshAsync();
  const environments = getEnvironments();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Environments</h1>
        <p className="text-slate-500 mt-1">
          Configure your Ping AIC tenant environments and their credentials.
        </p>
      </div>
      <EnvironmentsManager initialEnvironments={environments} />
    </div>
  );
}
