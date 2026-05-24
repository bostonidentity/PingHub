// src/webviews/ui/analyze/App.tsx
import { useEffect, useMemo, useState } from "react";

interface ResourceRef {
  realm: string;
  resourceType: "journey" | "script" | "saml2" | "OAuth2Client";
  id: string;
}

interface Reference {
  source: ResourceRef;
  target: ResourceRef;
  detail?: string;
}

interface ResultPayload {
  kind: "analyze-result";
  envName: string;
  target: ResourceRef;
  refs: Reference[];
}

interface AppProps {
  vscode: { postMessage(message: unknown): void };
}

function refKey(r: ResourceRef): string {
  return `${r.realm}/${r.resourceType}/${r.id}`;
}

export function App({ vscode }: AppProps) {
  const [data, setData] = useState<ResultPayload | undefined>();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    function onMessage(e: MessageEvent<ResultPayload>) {
      if (e.data.kind === "analyze-result") setData(e.data);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!filter) return data.refs;
    const f = filter.toLowerCase();
    return data.refs.filter((r) =>
      refKey(r.source).toLowerCase().includes(f) || (r.detail ?? "").toLowerCase().includes(f)
    );
  }, [data, filter]);

  // Group by source resource (so "Login uses validateUser 2 times" appears as one row with badge)
  const grouped = useMemo(() => {
    const map = new Map<string, Reference[]>();
    for (const r of filtered) {
      const k = refKey(r.source);
      const arr = map.get(k) ?? [];
      arr.push(r);
      map.set(k, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  function openRef(ref: ResourceRef) {
    if (!data) return;
    vscode.postMessage({ kind: "analyze-open-reference", envName: data.envName, ref });
  }

  if (!data) return <div className="status">Loading…</div>;

  return (
    <div className="analyze">
      <header>
        <h1>Find Usage</h1>
        <div className="target">
          <span className="muted">Target:</span>
          <code>{data.target.realm} / {data.target.resourceType} / {data.target.id}</code>
          <span className="muted">in <code>{data.envName}</code></span>
        </div>
      </header>

      <section className="controls">
        <input
          type="text"
          placeholder="Filter sources…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="count">{filtered.length} reference{filtered.length === 1 ? "" : "s"}</span>
      </section>

      {grouped.length === 0 ? (
        <p className="empty">
          {filter ? "No references match the filter." : `No references found targeting "${data.target.id}" in this env.`}
        </p>
      ) : (
        <section className="results">
          {grouped.map(([key, refs]) => {
            const src = refs[0].source;
            return (
              <div className="group" key={key}>
                <div className="group-header">
                  <button className="link" onClick={() => openRef(src)}>
                    {src.realm} / {src.resourceType} / {src.id}
                  </button>
                  <span className="badge">{refs.length}</span>
                </div>
                <ul>
                  {refs.map((r, i) => (
                    <li key={i}>{r.detail ?? "(no detail)"}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
