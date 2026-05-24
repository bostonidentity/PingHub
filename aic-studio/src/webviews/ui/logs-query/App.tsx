// src/webviews/ui/logs-query/App.tsx
import { useEffect, useState } from "react";

const SOURCES = [
  "am-everything",
  "am-authentication",
  "am-access",
  "am-config",
  "idm-everything",
  "idm-activity",
  "idm-recon"
] as const;

interface OpenPayload {
  kind: "logs-open";
  envName: string;
  savedQuery?: { id: number; name: string; source: string; filterExpr?: string };
}

interface LogEntry {
  timestamp: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

type ResultPayload =
  | { kind: "logs-result"; ok: true; entries: LogEntry[] }
  | { kind: "logs-result"; ok: false; error: string };

type SaveResultPayload =
  | { kind: "logs-save-result"; ok: true; id: number }
  | { kind: "logs-save-result"; ok: false; error: string };

type Payload = OpenPayload | ResultPayload | SaveResultPayload;

interface AppProps {
  vscode: { postMessage(message: unknown): void };
}

export function App({ vscode }: AppProps) {
  const [envName, setEnvName] = useState("");
  const [source, setSource] = useState<string>(SOURCES[0]);
  const [filterExpr, setFilterExpr] = useState("");
  const [beginTime, setBeginTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [results, setResults] = useState<LogEntry[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | undefined>();

  useEffect(() => {
    function onMessage(e: MessageEvent<Payload>) {
      const m = e.data;
      if (m.kind === "logs-open") {
        setEnvName(m.envName);
        if (m.savedQuery) {
          setSource(m.savedQuery.source);
          setFilterExpr(m.savedQuery.filterExpr ?? "");
        }
      } else if (m.kind === "logs-result") {
        setLoading(false);
        if (m.ok) {
          setResults(m.entries);
          setError(undefined);
        } else {
          setError(m.error);
          setResults([]);
        }
      } else if (m.kind === "logs-save-result") {
        setSaveStatus(m.ok ? `Saved (#${m.id})` : `Save failed: ${m.error}`);
        setTimeout(() => setSaveStatus(undefined), 3000);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function runQuery() {
    if (!envName) return;
    setLoading(true);
    setError(undefined);
    vscode.postMessage({
      kind: "logs-run",
      envName,
      source,
      filterExpr: filterExpr || undefined,
      beginTime: beginTime || undefined,
      endTime: endTime || undefined,
      pageSize: 100
    });
  }

  function saveQuery() {
    const name = window.prompt("Saved query name?");
    if (!name) return;
    vscode.postMessage({
      kind: "logs-save",
      envName,
      name,
      source,
      filterExpr: filterExpr || undefined
    });
  }

  return (
    <div className="logs">
      <header>
        <h1>Logs · <span className="muted">{envName}</span></h1>
      </header>

      <section className="controls">
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          Begin time
          <input type="text" placeholder="2026-05-24T00:00:00Z" value={beginTime} onChange={(e) => setBeginTime(e.target.value)} />
        </label>
        <label>
          End time
          <input type="text" placeholder="2026-05-24T23:59:59Z" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </label>
        <label className="filter-row">
          Filter expr
          <input type="text" placeholder='eventName eq "AM-LOGIN-FAILED"' value={filterExpr} onChange={(e) => setFilterExpr(e.target.value)} />
        </label>
        <div className="buttons">
          <button onClick={runQuery} disabled={loading || !envName}>{loading ? "Running…" : "Run"}</button>
          <button onClick={saveQuery} disabled={!envName} className="secondary">Save</button>
          {saveStatus && <span className="status">{saveStatus}</span>}
        </div>
      </section>

      {error && <section className="error">{error}</section>}

      {results && (
        <section className="results">
          <h2>Results ({results.length})</h2>
          {results.length === 0 ? (
            <p className="empty">No entries.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Time</th><th>Type</th><th>Payload</th></tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td className="time">{r.timestamp}</td>
                    <td className={`type type-${r.type}`}>{r.type}</td>
                    <td><pre>{JSON.stringify(r.payload, null, 2)}</pre></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
