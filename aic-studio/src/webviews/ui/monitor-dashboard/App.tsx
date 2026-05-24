// src/webviews/ui/monitor-dashboard/App.tsx
import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

interface MonitorItem {
  envName: string;
  envLabel: string;
  tls?: { status: string; daysRemaining?: number; detail?: string; checkedAt?: number };
  ping?: { status: string; detail?: string; checkedAt?: number };
  alertCount: number;
}

interface SummaryPayload {
  kind: "monitor-summary";
  items: MonitorItem[];
}

interface AppProps {
  vscode: { postMessage(message: unknown): void };
}

function tlsColor(days: number | undefined): string {
  if (days === undefined) return "#888";
  if (days < 14) return "#e74c3c";
  if (days < 30) return "#f39c12";
  return "#27ae60";
}

export function App({ vscode }: AppProps) {
  const [items, setItems] = useState<MonitorItem[]>([]);

  useEffect(() => {
    function onMessage(e: MessageEvent<SummaryPayload>) {
      if (e.data.kind === "monitor-summary") {
        setItems(e.data.items);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const tlsData = items
    .filter((i) => i.tls?.daysRemaining !== undefined)
    .map((i) => ({ name: i.envLabel, days: i.tls!.daysRemaining! }));

  return (
    <div className="dashboard">
      <header>
        <h1>Monitor Dashboard</h1>
        <button onClick={() => vscode.postMessage({ kind: "monitor-refresh" })}>Refresh</button>
      </header>

      <section>
        <h2>TLS days remaining</h2>
        {tlsData.length === 0 ? (
          <p className="empty">No TLS check data. Run AIC Studio: Poll monitors now.</p>
        ) : (
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={tlsData}>
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="days">
                  {tlsData.map((d, i) => (
                    <Cell key={i} fill={tlsColor(d.days)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section>
        <h2>Environments</h2>
        <table>
          <thead>
            <tr>
              <th>Env</th>
              <th>TLS</th>
              <th>Ping</th>
              <th>Alerts</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.envName}>
                <td>{i.envLabel} <span className="muted">({i.envName})</span></td>
                <td><span className={`status-${i.tls?.status ?? "unknown"}`}>{i.tls?.status ?? "—"}</span>{i.tls?.daysRemaining !== undefined && <span className="muted"> · {i.tls.daysRemaining}d</span>}</td>
                <td><span className={`status-${i.ping?.status ?? "unknown"}`}>{i.ping?.status ?? "—"}</span>{i.ping?.detail && <span className="muted"> · {i.ping.detail}</span>}</td>
                <td className={i.alertCount > 0 ? "alert" : ""}>{i.alertCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
