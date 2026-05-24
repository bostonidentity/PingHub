// src/webviews/ui/dashboard/App.tsx
import { useEffect, useState } from "react";

interface EnvItem {
  envName: string;
  envLabel: string;
  lastPullAt?: number;
  snapshotCount: number;
  recentOpCount: number;
  hasMonitorAlerts: boolean;
}

interface Summary {
  kind: "dashboard-summary";
  envs: EnvItem[];
  totalRecentOps: number;
  totalAlerts: number;
}

interface AppProps {
  vscode: { postMessage(message: unknown): void };
}

function formatTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export function App({ vscode }: AppProps) {
  const [summary, setSummary] = useState<Summary | undefined>();

  useEffect(() => {
    function onMessage(e: MessageEvent<Summary>) {
      if (e.data.kind === "dashboard-summary") setSummary(e.data);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!summary) return <div className="status">Loading…</div>;

  return (
    <div className="dashboard">
      <header>
        <h1>AIC Studio Dashboard</h1>
        <button onClick={() => vscode.postMessage({ kind: "dashboard-refresh" })}>Refresh</button>
      </header>

      <section className="stats">
        <div className="stat">
          <div className="stat-label">Environments</div>
          <div className="stat-value">{summary.envs.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Ops this week</div>
          <div className="stat-value">{summary.totalRecentOps}</div>
        </div>
        <div className={`stat ${summary.totalAlerts > 0 ? "alert" : ""}`}>
          <div className="stat-label">Active alerts</div>
          <div className="stat-value">{summary.totalAlerts}</div>
        </div>
      </section>

      <section>
        <h2>Environments</h2>
        {summary.envs.length === 0 ? (
          <p className="empty">No environments configured. Run "AIC Studio: Add environment…"</p>
        ) : (
          <div className="env-grid">
            {summary.envs.map((e) => (
              <div className={`env-card ${e.hasMonitorAlerts ? "alert" : ""}`} key={e.envName}>
                <div className="env-card-header">
                  <h3>{e.envLabel}</h3>
                  <code>{e.envName}</code>
                </div>
                <dl>
                  <dt>Last pull</dt><dd>{formatTime(e.lastPullAt)}</dd>
                  <dt>Snapshots</dt><dd>{e.snapshotCount}</dd>
                  <dt>Recent ops</dt><dd>{e.recentOpCount}</dd>
                  {e.hasMonitorAlerts && <><dt>Alerts</dt><dd className="alert-text">active</dd></>}
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
