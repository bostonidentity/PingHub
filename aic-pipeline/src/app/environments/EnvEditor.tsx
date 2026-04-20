"use client";

import { useEffect, useState, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { Environment, EnvironmentType } from "@/lib/fr-config-types";
import { EnvironmentBadge } from "@/components/EnvironmentBadge";
import { parseEnvFile, serializeEnvFile } from "@/lib/env-parser";
import { cn } from "@/lib/utils";
import { LogEntry } from "@/hooks/useStreamingLogs";
import { ServiceAccountScopeSelector } from "@/components/ServiceAccountScopeSelector";
import { StatusPill } from "@/components/ui/StatusPill";
import { useDialog } from "@/components/ConfirmDialog";

// ── Field definitions ────────────────────────────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  description: string;
  required: boolean;
  sensitive?: boolean;
  placeholder?: string;
  type?: "text" | "json-array" | "path" | "scope-tags";
}

const FIELD_GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "Tenant Connection",
    fields: [
      {
        key: "TENANT_BASE_URL",
        label: "Tenant Base URL",
        description: "Root URL of the tenant — do NOT include /am (the CLI appends that). e.g. https://tenant.forgeblocks.com",
        required: true,
        placeholder: "https://your-tenant.forgeblocks.com",
      },
      {
        key: "SERVICE_ACCOUNT_CLIENT_ID",
        label: "Service Account Client ID",
        description: "OAuth2 client ID for the service account. Typically 'service-account'.",
        required: true,
        placeholder: "service-account",
      },
      {
        key: "SERVICE_ACCOUNT_ID",
        label: "Service Account ID",
        description: "UUID of the service account, used as the JWT issuer (SERVICE_ACCOUNT_ID).",
        required: true,
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        key: "SERVICE_ACCOUNT_SCOPE",
        label: "Service Account Scope",
        description: "OAuth2 scope(s) requested by the service account. Add each scope as a pill.",
        required: true,
        placeholder: "fr:idm:*",
        type: "scope-tags",
      },
      {
        key: "SERVICE_ACCOUNT_KEY",
        label: "Service Account Private Key",
        description: "PEM-encoded private key for the service account (paste full key including header/footer).",
        required: true,
        sensitive: true,
        placeholder: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
      },
    ],
  },
  {
    title: "Config Repository",
    fields: [
      {
        key: "CONFIG_DIR",
        label: "Config Directory",
        description: "Absolute or relative path to the local config repository directory.",
        required: true,
        placeholder: "./config",
        type: "path",
      },
      {
        key: "REALMS",
        label: "Realms",
        description: 'JSON array of realm names to manage, e.g. ["alpha"] or ["alpha","bravo"]. Required by fr-config-pull.',
        required: true,
        placeholder: '["alpha"]',
        type: "json-array",
      },
      {
        key: "SCRIPT_PREFIXES",
        label: "Script Prefixes",
        description: 'JSON array of script name prefixes to include, e.g. ["MyOrg-"]. Use [""] to include all scripts.',
        required: true,
        placeholder: '["MyOrg-"]',
        type: "json-array",
      },
    ],
  },
  {
    title: "Safety & Behaviour",
    fields: [
      {
        key: "DEPLOYMENT_TYPE",
        label: "Deployment Type",
        description: "CLOUD (default), PLATFORM, or AM.",
        required: false,
        placeholder: "CLOUD",
      },
      {
        key: "TENANT_READONLY",
        label: "Tenant Read-only",
        description: "Set to true to prevent fr-config-push from writing to this tenant.",
        required: false,
        placeholder: "false",
      },
      {
        key: "PUSH_NAMED_ONLY",
        label: "Push Named Only",
        description: "Set to true to only allow push for explicitly named config.",
        required: false,
        placeholder: "false",
      },
      {
        key: "ACTIVE_ONLY_SECRETS",
        label: "Active Only Secrets",
        description: "Only pull/push the current active secret version, not all versions.",
        required: false,
        placeholder: "true",
      },
      {
        key: "UPDATE_CHANGED_ONLY",
        label: "Update Changed Only",
        description: "Only push scripts if they have changed.",
        required: false,
        placeholder: "true",
      },
    ],
  },
  {
    title: "Optional Config Files",
    fields: [
      {
        key: "AGENTS_CONFIG_FILE",
        label: "Agents Config File",
        description: "Path to JSON file listing OAuth2 agents to manage.",
        required: false,
        placeholder: "./config/agents.json",
        type: "path",
      },
      {
        key: "SAML_CONFIG_FILE",
        label: "SAML Config File",
        description: "Path to JSON file listing SAML entities to manage.",
        required: false,
        placeholder: "./config/saml.json",
        type: "path",
      },
      {
        key: "POLICIES_CONFIG_FILE",
        label: "Policies Config File",
        description: "Path to JSON file listing policy sets to manage.",
        required: false,
        placeholder: "./config/policies.json",
        type: "path",
      },
      {
        key: "OBJECTS_CONFIG_FILE",
        label: "Managed Objects Config File",
        description: "Path to JSON file listing managed objects to include.",
        required: false,
        placeholder: "./config/objects.json",
        type: "path",
      },
      {
        key: "RAW_CONFIG_FILE",
        label: "Raw Config File",
        description: "Path to JSON file listing raw AM config endpoints to manage.",
        required: false,
        placeholder: "./config/raw.json",
        type: "path",
      },
      {
        key: "CSP_CONFIG_FILE",
        label: "CSP Config File",
        description: "Path to JSON file for Content Security Policy configuration.",
        required: false,
        placeholder: "./config/csp.json",
        type: "path",
      },
    ],
  },
];

const ALL_KNOWN_KEYS = new Set(
  FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key))
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMissingRequired(values: Record<string, string>): string[] {
  return FIELD_GROUPS.flatMap((g) => g.fields)
    .filter((f) => f.required && !values[f.key]?.trim())
    .map((f) => f.label);
}

// ── Sub-components ───────────────────────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDef;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const isTextArea =
    field.sensitive || (field.type === "json-array" && value.length > 60);

  if (field.type === "scope-tags") {
    return (
      <ServiceAccountScopeSelector
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (field.sensitive || field.key === "SERVICE_ACCOUNT_KEY") {
    return (
      <div className="relative">
        <textarea
          rows={visible ? 6 : 2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={field.placeholder}
          className="w-full font-mono text-xs rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50 resize-none"
          style={{ filter: visible ? "none" : "blur(3px)", userSelect: visible ? "auto" : "none" }}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute top-1.5 right-2 text-xs text-slate-400 hover:text-slate-700"
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    );
  }

  if (isTextArea) {
    return (
      <textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={field.placeholder}
        className="w-full font-mono text-xs rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50 resize-none"
      />
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={field.placeholder}
      className="w-full font-mono text-xs rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
    />
  );
}

// ── Test Log API ──────────────────────────────────────────────────────────────

function TestLogApiButton({
  tenantBaseUrl,
  apiKey,
  apiSecret,
}: {
  tenantBaseUrl: string;
  apiKey: string;
  apiSecret: string;
}) {
  const [running, setRunning] = useState(false);
  const [debug, setDebug] = useState(false);
  const [logs, setLogs] = useState<{ type: string; data: string }[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [logs]);

  const run = async (isDebug: boolean) => {
    setLogs([]);
    setExitCode(null);
    setRunning(true);
    try {
      const res = await fetch("/api/environments/test-log-api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantBaseUrl, apiKey, apiSecret, debug: isDebug }),
      });
      const data = await res.json();
      if (data.ok) {
        const entries: { type: string; data: string }[] = [
          { type: "stdout", data: `HTTP ${data.status} — connection successful` },
        ];
        if (isDebug && data.body) {
          entries.push({ type: "stdout", data: data.body });
        }
        setLogs(entries);
        setExitCode(0);
      } else {
        const entries: { type: string; data: string }[] = [
          { type: "stderr", data: data.message || `HTTP ${data.status}` },
        ];
        if (isDebug && data.body) {
          entries.push({ type: "stderr", data: data.body });
        }
        setLogs(entries);
        setExitCode(1);
      }
    } catch (err) {
      setLogs([{ type: "error", data: String(err) }]);
      setExitCode(1);
    } finally {
      setRunning(false);
    }
  };

  const statusColor = exitCode === null
    ? running ? "text-yellow-400" : "text-slate-400"
    : exitCode === 0 ? "text-green-400" : "text-red-400";

  const statusDot = running
    ? "bg-yellow-400 animate-pulse"
    : exitCode === null ? "bg-slate-400"
    : exitCode === 0 ? "bg-green-400" : "bg-red-400";

  return (
    <div className="space-y-2 w-full">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => run(debug)}
          disabled={running || !apiKey || !apiSecret || !tenantBaseUrl}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
        >
          {running ? "Testing..." : "Test Log API"}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => setDebug(e.target.checked)}
            disabled={running}
            className="accent-sky-600"
          />
          Debug
        </label>
        {logs.length > 0 && !running && (
          <button
            type="button"
            onClick={() => { setLogs([]); setExitCode(null); }}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {logs.length > 0 && (
        <div className="rounded-md overflow-hidden border border-slate-700">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700">
            <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDot)} />
            <span className={cn("text-xs font-mono", statusColor)}>
              {running
                ? "Connecting to Log API..."
                : exitCode === 0 ? "Log API credentials valid"
                : exitCode !== null ? "Log API test failed"
                : ""}
            </span>
          </div>
          <div className="bg-slate-900 p-3 font-mono text-xs max-h-48 overflow-y-auto">
            {logs.map((entry, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-all leading-5",
                  entry.type === "stderr" && "text-yellow-300",
                  entry.type === "error" && "text-red-400",
                  entry.type === "stdout" && "text-slate-100"
                )}
              >
                {entry.data}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Test Connection ───────────────────────────────────────────────────────────

function TestConnectionButton({
  liveValues,
}: {
  liveValues: Record<string, string>;
}) {
  const [running, setRunning] = useState(false);
  const [debug, setDebug] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [logs]);

  const run = async (isDebug: boolean) => {
    setLogs([]);
    setExitCode(null);
    setRunning(true);

    try {
      const res = await fetch("/api/environments/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envVars: liveValues, debug: isDebug }),
      });

      if (!res.ok || !res.body) {
        setLogs([{ type: "error", data: await res.text() || "Request failed", ts: Date.now() }]);
        setRunning(false);
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      readerRef.current = reader;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry: LogEntry = JSON.parse(line);
            setLogs((prev) => [...prev, entry]);
            if (entry.type === "exit") setExitCode(entry.code ?? null);
          } catch { /* ignore malformed */ }
        }
      }
    } catch (err) {
      setLogs((prev) => [...prev, { type: "error", data: String(err), ts: Date.now() }]);
    } finally {
      setRunning(false);
      readerRef.current = null;
    }
  };

  const statusColor = exitCode === null
    ? running ? "text-yellow-400" : "text-slate-400"
    : exitCode === 0 ? "text-green-400" : "text-red-400";

  const statusDot = running
    ? "bg-yellow-400 animate-pulse"
    : exitCode === null ? "bg-slate-400"
    : exitCode === 0 ? "bg-green-400" : "bg-red-400";

  const inlinePill = running ? (
    <StatusPill tone="info">testing…</StatusPill>
  ) : exitCode === 0 ? (
    <StatusPill tone="success">ok</StatusPill>
  ) : exitCode !== null ? (
    <StatusPill tone="danger">failed</StatusPill>
  ) : null;

  return (
    <div className="space-y-2 w-full">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => run(debug)}
          disabled={running}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
        >
          {running ? "Testing..." : "Test Connection"}
        </button>
        {inlinePill}
        <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => setDebug(e.target.checked)}
            disabled={running}
            className="accent-sky-600"
          />
          Debug
        </label>
        {logs.length > 0 && !running && (
          <button
            type="button"
            onClick={() => { setLogs([]); setExitCode(null); }}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {logs.length > 0 && (
        <div className="rounded-md overflow-hidden border border-slate-700">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700">
            <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDot)} />
            <span className={cn("text-xs font-mono", statusColor)}>
              {running ? "Running fr-config-pull test..." : exitCode === 0 ? "Connection successful" : exitCode !== null ? `Failed (exit code ${exitCode})` : ""}
            </span>
          </div>
          <div className="bg-slate-900 p-3 font-mono text-xs max-h-48 overflow-y-auto">
            {logs.map((entry, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-all leading-5",
                  entry.type === "stderr" && "text-yellow-300",
                  entry.type === "error" && "text-red-400",
                  entry.type === "exit" && entry.code === 0 && "text-green-400 font-bold",
                  entry.type === "exit" && entry.code !== 0 && "text-red-400 font-bold",
                  entry.type === "stdout" && "text-slate-100"
                )}
              >
                {entry.type === "exit"
                  ? `\n[Process exited with code ${entry.code}]`
                  : entry.data}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Restart Tenant ────────────────────────────────────────────────────────

export type RestartHandle = { triggerRestart: () => void; isPolling: () => boolean };

interface RestartButtonProps {
  environmentName: string;
  envType: EnvironmentType;
  isDev: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** Hide the internal "Restart Tenant" trigger; use the imperative ref instead. */
  hideTrigger?: boolean;
}

const RestartButton = forwardRef<RestartHandle, RestartButtonProps>(function RestartButton({
  environmentName,
  envType,
  isDev,
  onBusyChange,
  hideTrigger,
}, ref) {
  const [logs, setLogs] = useState<string[]>([]);
  const [polling, setPolling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [finalStatus, setFinalStatus] = useState<"ready" | "error" | null>(null);
  // For higher (non-dev) controlled envs, allow polling DCC session state
  // instead of the tenant restart status.
  const canUseDccMode = envType === "controlled" && !isDev;
  const [dccMode, setDccMode] = useState(false);
  const pollingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { confirm } = useDialog();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [logs]);

  const callRestart = async (action: "restart" | "status") => {
    const res = await fetch("/api/environments/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: environmentName, action }),
    });
    return res.json() as Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  };

  const callDccState = async () => {
    const res = await fetch("/api/dcc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: environmentName, subcommand: "direct-control-state" }),
    });
    return res.json() as Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  };

  const log = (msg: string) => setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  useEffect(() => { return () => { pollingRef.current = false; }; }, []);

  // Notify parent (modal wrapper) whenever polling state changes so it can
  // block accidental dismissal while a tenant poll is in flight.
  useEffect(() => { onBusyChange?.(polling); }, [polling, onBusyChange]);

  const startPolling = useCallback(async (useDcc: boolean) => {
    pollingRef.current = true;
    setPolling(true);
    setStopping(false);
    setFinalStatus(null);
    let loggedReady = false;
    while (pollingRef.current) {
      try {
        let s: string;
        if (useDcc) {
          const dccRes = await callDccState();
          if (!pollingRef.current) break;
          let parsed: { status?: string; editable?: boolean } = {};
          try { parsed = JSON.parse(dccRes.stdout.trim()); } catch { /* ignore */ }
          s = parsed.status ?? dccRes.stdout.trim() ?? "unknown";
          log(`DCC status: ${s}${parsed.editable !== undefined ? ` (editable=${parsed.editable})` : ""}`);
          // "Ready" in DCC mode means an idle, applyable or fresh state.
          const isReady = s === "SESSION_INITIALISED" || s === "SESSION_APPLIED" || s === "NO_SESSION";
          if (isReady && !loggedReady) {
            setFinalStatus("ready");
            loggedReady = true;
          } else if (!isReady && loggedReady) {
            loggedReady = false;
            setFinalStatus(null);
          }
        } else {
          const statusRes = await callRestart("status");
          if (!pollingRef.current) break;
          s = statusRes.stdout.trim();
          log(`Status: ${s}`);
          if (s === "ready") {
            if (!loggedReady) {
              log("Environment is ready.");
              setFinalStatus("ready");
              loggedReady = true;
            }
          } else if (loggedReady) {
            loggedReady = false;
            setFinalStatus(null);
          }
        }
      } catch {
        log("Error: Failed to check status");
        setFinalStatus("error");
        pollingRef.current = false;
        break;
      }
      // Sleep in short chunks so Stop can break out within ~200ms
      // instead of waiting for a full 10-second tick.
      for (let elapsed = 0; elapsed < 10_000 && pollingRef.current; elapsed += 200) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!finalStatus) log("Polling stopped.");
    setPolling(false);
    setStopping(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentName]);

  const handleStop = () => {
    if (!polling || stopping) return;
    setStopping(true);
    log("Stop requested — waiting for current status check to finish...");
    pollingRef.current = false;
  };

  const handleRestart = async () => {
    const ok = await confirm({
      title: `Restart tenant "${environmentName}"?`,
      message:
        "This restarts the tenant backend. Active sessions may be interrupted and the tenant will be unavailable for a few minutes while it comes back up.",
      confirmLabel: "Restart tenant",
      variant: "danger",
    });
    if (!ok) return;

    setLogs([]);
    setFinalStatus(null);
    log("Initiating restart...");
    try {
      const res = await callRestart("restart");
      if (res.exitCode !== 0) {
        log(`Error: ${res.stderr || res.stdout || "Restart failed"}`);
        setFinalStatus("error");
        return;
      }
      log("Restart initiated. Polling status...");
      startPolling(false);
    } catch {
      log("Error: Failed to initiate restart");
      setFinalStatus("error");
    }
  };

  const handlePollStatus = () => {
    setLogs([]);
    setFinalStatus(null);
    const useDcc = canUseDccMode && dccMode;
    log(useDcc ? "Polling --direct-control state..." : "Polling status...");
    startPolling(useDcc);
  };

  const statusDot = finalStatus === "ready" ? "bg-green-400" : finalStatus === "error" ? "bg-red-400" : polling ? "bg-amber-400 animate-pulse" : "bg-slate-300";
  const statusLabel = finalStatus === "ready" ? "Ready" : finalStatus === "error" ? "Failed" : polling ? "Restarting" : "";
  const statusTextColor = finalStatus === "ready" ? "text-green-400" : finalStatus === "error" ? "text-red-400" : "text-yellow-400";

  useImperativeHandle(ref, () => ({
    triggerRestart: handleRestart,
    isPolling: () => polling,
  }), [handleRestart, polling]);

  return (
    <div className="space-y-2 w-full">
      <div className="flex items-center gap-2 flex-wrap">
        {!hideTrigger && (
          <button
            type="button"
            onClick={handleRestart}
            disabled={polling}
            className="px-3 py-1.5 text-xs font-medium rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors"
          >
            Restart Tenant
          </button>
        )}
        <button
          type="button"
          onClick={handlePollStatus}
          disabled={polling}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
        >
          Poll Status
        </button>
        {polling && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 text-slate-500 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
        {stopping && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Waiting for current status check to finish…
          </span>
        )}
        {canUseDccMode && (
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 ml-1 select-none">
            <input
              type="checkbox"
              checked={dccMode}
              disabled={polling}
              onChange={(e) => setDccMode(e.target.checked)}
              className="w-3.5 h-3.5 accent-sky-600"
            />
            Poll --direct-control state
          </label>
        )}
      </div>

      {logs.length > 0 && (
        <div className="rounded-md overflow-hidden border border-slate-700">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700">
            <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDot)} />
            <span className={cn("text-xs font-mono", statusTextColor)}>{statusLabel}</span>
            {!polling && logs.length > 0 && (
              <button
                type="button"
                onClick={() => { setLogs([]); setFinalStatus(null); }}
                className="ml-auto text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div className="bg-slate-900 p-3 font-mono text-xs max-h-48 overflow-y-auto">
            {logs.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap leading-5",
                  line.includes("Error") ? "text-red-400" : line.includes("complete") || line.includes("ready") ? "text-green-400" : "text-slate-300"
                )}
              >
                {line}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  );
});

// ── Main Editor ───────────────────────────────────────────────────────────────

type Section = "fr-config" | "log-api";
type SubTab = "form" | "raw";

export function EnvEditor({ env, onUpdate, onBusyChange }: { env: Environment; onUpdate?: (updated: Environment) => void; onBusyChange?: (busy: boolean) => void }) {
  const restartRef = useRef<RestartHandle>(null);
  const [restartPolling, setRestartPolling] = useState(false);
  const [section, setSection] = useState<Section>("fr-config");
  const [subTab, setSubTab] = useState<SubTab>("form");
  const [rawContent, setRawContent] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState(env.label);
  const [color, setColor] = useState<Environment["color"]>(env.color);
  const [envType, setEnvType] = useState<EnvironmentType>(env.type ?? "sandbox");
  const [devEnvironment, setDevEnvironment] = useState(env.devEnvironment ?? false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Log API state
  const [logApiKey, setLogApiKey] = useState("");
  const [logApiSecret, setLogApiSecret] = useState("");
  const [logApiKeyVisible, setLogApiKeyVisible] = useState(false);
  const [logApiSecretVisible, setLogApiSecretVisible] = useState(false);

  // Load .env content + log API creds on mount / env change
  useEffect(() => {
    setLoading(true);
    setSaved(false);
    setError("");
    setLabel(env.label);
    setColor(env.color);
    setEnvType(env.type ?? "sandbox");
    setDevEnvironment(env.devEnvironment ?? false);
    fetch(`/api/environments/${env.name}`)
      .then((r) => r.json())
      .then((data) => {
        const content = data.content ?? "";
        setRawContent(content);
        setValues(parseEnvFile(content));
        setLogApiKey(data.logApi?.apiKey ?? "");
        setLogApiSecret(data.logApi?.apiSecret ?? "");
        setLoading(false);
      });
  }, [env.name]);

  // Sync form → raw when switching sub-tabs
  const handleSubTabChange = useCallback(
    (next: SubTab) => {
      if (next === "raw" && subTab === "form") {
        setRawContent(serializeEnvFile(values, rawContent));
      }
      if (next === "form" && subTab === "raw") {
        setValues(parseEnvFile(rawContent));
      }
      setSubTab(next);
    },
    [subTab, values, rawContent]
  );

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const currentRaw = subTab === "form" ? serializeEnvFile(values, rawContent) : rawContent;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    const body: Record<string, unknown> = {
      label,
      color,
      type: envType,
      devEnvironment: envType === "controlled" ? devEnvironment : undefined,
      envContent: currentRaw,
    };
    if (logApiKey || logApiSecret) {
      body.logApi = { apiKey: logApiKey, apiSecret: logApiSecret };
    }
    const res = await fetch(`/api/environments/${env.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const updated = await res.json();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onUpdate?.(updated);
    } else {
      setError("Save failed.");
    }
    setSaving(false);
  };

  const missing = getMissingRequired(values);

  return (
    <div className="card-padded space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <EnvironmentBadge env={{ ...env, label, color }} />
          <span className="text-xs font-mono text-slate-400">{env.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-red-600">{error}</span>}
          {saved && <StatusPill tone="success">Saved</StatusPill>}
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="btn-primary"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-slate-400 text-sm text-center">Loading...</div>
      ) : (
        <>
          {/* Metadata row */}
          <div className="flex flex-wrap items-end gap-4 py-3 border-b border-slate-100 bg-slate-50/50">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Display Name</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="block rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 w-44"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Color</label>
              <select
                value={color}
                onChange={(e) => setColor(e.target.value as Environment["color"])}
                className="block rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value="green">Green</option>
                <option value="blue">Blue</option>
                <option value="teal">Teal</option>
                <option value="indigo">Indigo</option>
                <option value="purple">Purple</option>
                <option value="pink">Pink</option>
                <option value="yellow">Yellow</option>
                <option value="orange">Orange</option>
                <option value="red">Red (Production)</option>
                <option value="gray">Gray</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Type</label>
              <select
                value={envType}
                onChange={(e) => setEnvType(e.target.value as EnvironmentType)}
                className="block rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value="sandbox">Sandbox Environment</option>
                <option value="controlled">Controlled Environment</option>
              </select>
            </div>
            {envType === "controlled" && (
              <div className="space-y-1 self-end pb-0.5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={devEnvironment}
                    onChange={(e) => setDevEnvironment(e.target.checked)}
                    className="accent-sky-600 w-4 h-4"
                  />
                  <span>Dev Environment</span>
                </label>
                <p className="text-xs text-slate-400">First environment in the pipeline</p>
              </div>
            )}
          </div>

          {/* ── Section tabs (fr-config / Log API) ──────────────────────── */}
          <div className="flex border-b border-slate-200">
            {([
              { key: "fr-config" as Section, label: "fr-config" },
              { key: "log-api" as Section, label: "Log API" },
            ]).map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={cn(
                  "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
                  section === s.key
                    ? "border-sky-500 text-sky-700"
                    : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* ═══════════ fr-config section ═══════════ */}
          {section === "fr-config" && (
            <>
              {/* Test connection & restart */}
              <div className="py-3 border-b border-slate-100 bg-slate-50/50 space-y-3">
                <div className="flex items-start gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => restartRef.current?.triggerRestart()}
                    disabled={restartPolling}
                    className="px-3 py-1.5 text-xs font-medium rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors shrink-0"
                  >
                    Restart Tenant
                  </button>
                  <div className="flex-1 min-w-0">
                    <TestConnectionButton liveValues={values} />
                  </div>
                </div>
                <RestartButton
                  ref={restartRef}
                  environmentName={env.name}
                  envType={envType}
                  isDev={devEnvironment}
                  onBusyChange={(busy) => { setRestartPolling(busy); onBusyChange?.(busy); }}
                  hideTrigger
                />
              </div>

              {/* Sub-tabs: Form / Raw */}
              <div className="flex border-b border-slate-200">
                {(["form", "raw"] as SubTab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => handleSubTabChange(t)}
                    className={cn(
                      "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
                      subTab === t
                        ? "border-sky-500 text-sky-700"
                        : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300"
                    )}
                  >
                    {t === "form" ? "Form" : "Raw .env"}
                  </button>
                ))}
              </div>

              {/* Validation banner */}
              {subTab === "form" && missing.length > 0 && (
                <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700">
                  Required fields missing: {missing.join(", ")}
                </div>
              )}

              {/* Form sub-tab */}
              {subTab === "form" && (
                <div className="space-y-6 overflow-y-auto max-h-[600px]">
                  {FIELD_GROUPS.map((group) => (
                    <div key={group.title} className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-100 pb-1">
                        {group.title}
                      </h3>
                      {group.fields.map((field) => (
                        <div key={field.key} className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <label className="text-sm font-medium text-slate-700">
                              {field.label}
                            </label>
                            {field.required && (
                              <span className="text-red-500 text-xs">*</span>
                            )}
                            {field.sensitive && (
                              <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">sensitive</span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400">{field.description}</p>
                          <FieldInput
                            field={field}
                            value={values[field.key] ?? ""}
                            onChange={(v) => setField(field.key, v)}
                          />
                        </div>
                      ))}
                    </div>
                  ))}

                  {/* Extra unknown keys */}
                  {Object.entries(values)
                    .filter(([k]) => !ALL_KNOWN_KEYS.has(k))
                    .map(([key, val]) => (
                      <div key={key} className="space-y-1">
                        <label className="text-sm font-medium text-slate-700 font-mono">{key}</label>
                        <p className="text-xs text-slate-400">Custom / unrecognised variable.</p>
                        <input
                          type="text"
                          value={val}
                          onChange={(e) => setField(key, e.target.value)}
                          className="w-full font-mono text-xs rounded border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                        />
                      </div>
                    ))}
                </div>
              )}

              {/* Raw sub-tab */}
              {subTab === "raw" && (
                <div>
                  <p className="text-xs text-slate-400 pt-3 pb-1">
                    Direct edit of the .env file. Changes here are reflected in the form view on next switch.
                  </p>
                  <textarea
                    value={rawContent}
                    onChange={(e) => setRawContent(e.target.value)}
                    spellCheck={false}
                    className="w-full h-96 font-mono text-sm p-4 focus:outline-none resize-none text-green-300 bg-slate-900"
                    placeholder={`TENANT_BASE_URL=https://your-tenant.forgeblocks.com/am\nSERVICE_ACCOUNT_ID=\nSERVICE_ACCOUNT_KEY=\nCONFIG_DIR=./config\nSCRIPT_PREFIXES=[]`}
                  />
                </div>
              )}
            </>
          )}

          {/* ═══════════ Log API section ═══════════ */}
          {section === "log-api" && (
            <>
              {/* Test Log API */}
              <div className="py-3 border-b border-slate-100 bg-slate-50/50">
                <TestLogApiButton
                  tenantBaseUrl={values["TENANT_BASE_URL"] ?? ""}
                  apiKey={logApiKey}
                  apiSecret={logApiSecret}
                />
              </div>

              <div className="space-y-6 max-w-lg py-4">
                <div>
                  <p className="text-xs text-slate-500">
                    API key and secret for accessing PingOne Advanced Identity Cloud monitoring logs.
                    Create these in the AIC admin console under Tenant Settings &gt; Log API Keys.
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">API Key</label>
                  <p className="text-xs text-slate-400">The API key ID from the AIC admin console.</p>
                  <div className="relative">
                    <input
                      type={logApiKeyVisible ? "text" : "password"}
                      value={logApiKey}
                      onChange={(e) => setLogApiKey(e.target.value)}
                      placeholder="e.g. a1b2c3d4e5f6..."
                      className="w-full font-mono text-xs rounded border border-slate-300 px-3 py-2 pr-14 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                    <button
                      type="button"
                      onClick={() => setLogApiKeyVisible((v) => !v)}
                      className="absolute top-1.5 right-2 text-xs text-slate-400 hover:text-slate-700"
                    >
                      {logApiKeyVisible ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">API Secret</label>
                  <p className="text-xs text-slate-400">The API secret paired with the key above.</p>
                  <div className="relative">
                    <input
                      type={logApiSecretVisible ? "text" : "password"}
                      value={logApiSecret}
                      onChange={(e) => setLogApiSecret(e.target.value)}
                      placeholder="e.g. x9y8z7w6v5u4..."
                      className="w-full font-mono text-xs rounded border border-slate-300 px-3 py-2 pr-14 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                    <button
                      type="button"
                      onClick={() => setLogApiSecretVisible((v) => !v)}
                      className="absolute top-1.5 right-2 text-xs text-slate-400 hover:text-slate-700"
                    >
                      {logApiSecretVisible ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                <div className="pt-2">
                  <p className="text-xs text-slate-400">
                    These credentials are stored locally in <code className="font-mono bg-slate-100 px-1 rounded">{env.name}/log-api.json</code> and
                    are used to query the <code className="font-mono bg-slate-100 px-1 rounded">/monitoring/logs</code> endpoint.
                  </p>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
