import { getEnvironments, getLogApiCredentials } from "@/lib/fr-config";
import { LogsExplorerTabs } from "./LogsExplorer";

export default function LogsPage() {
  const environments = getEnvironments().map((env) => ({
    ...env,
    hasLogApi: getLogApiCredentials(env.name) !== null,
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Logs</h1>
        <p className="section-subtitle mt-1">Search and inspect tenant logs.</p>
      </header>
      <LogsExplorerTabs environments={environments} />
    </div>
  );
}
