// src/webviews/ui/federation-editor/App.tsx
import { useEffect, useState } from "react";

interface LoadPayload {
  kind: "load";
  envName: string;
  realm: string;
  federationType: string;
  id: string;
  body: Record<string, unknown> | null;
}

interface SaveResultPayload {
  kind: "save-result";
  ok: boolean;
  error?: string;
}

type Payload = LoadPayload | SaveResultPayload;

interface AppProps {
  vscode: { postMessage(message: unknown): void };
}

export function App({ vscode }: AppProps) {
  const [load, setLoad] = useState<LoadPayload | undefined>();
  const [saveResult, setSaveResult] = useState<SaveResultPayload | undefined>();
  const [edited, setEdited] = useState<string>("");

  useEffect(() => {
    function onMessage(e: MessageEvent<Payload>) {
      const m = e.data;
      if (m.kind === "load") {
        setLoad(m);
        setEdited(m.body ? JSON.stringify(m.body, null, 2) : "");
        setSaveResult(undefined);
      } else if (m.kind === "save-result") {
        setSaveResult(m);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!load) {
    return <div className="status">Loading…</div>;
  }

  if (!load.body) {
    return (
      <div className="status">
        <h2>{load.realm} / {load.federationType} / {load.id}</h2>
        <p>No snapshot for this federation item in <code>{load.envName}</code>.</p>
        <p>Run <strong>AIC Studio: Pull from environment</strong> first.</p>
      </div>
    );
  }

  function onSave() {
    try {
      const parsed = JSON.parse(edited);
      vscode.postMessage({
        kind: "save",
        envName: load!.envName,
        realm: load!.realm,
        federationType: load!.federationType,
        id: load!.id,
        body: parsed
      });
    } catch (err) {
      setSaveResult({
        kind: "save-result",
        ok: false,
        error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  return (
    <div className="editor">
      <header>
        <h2>{load.realm} / {load.federationType} / {load.id}</h2>
        <p>Environment: <code>{load.envName}</code></p>
      </header>
      <textarea
        spellCheck={false}
        value={edited}
        onChange={(e) => setEdited(e.target.value)}
      />
      <div className="actions">
        <button onClick={onSave}>Save</button>
        {saveResult && (
          <span className={saveResult.ok ? "ok" : "err"}>
            {saveResult.ok ? "✓ Saved" : `✗ ${saveResult.error ?? "Save failed"}`}
          </span>
        )}
      </div>
    </div>
  );
}
