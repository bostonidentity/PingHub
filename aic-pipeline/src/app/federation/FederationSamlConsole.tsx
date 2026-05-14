"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Check, Clipboard, RefreshCw, Search } from "lucide-react";

import { EnvironmentBadge } from "@/components/EnvironmentBadge";
import { StatusPill } from "@/components/ui/StatusPill";
import { cn } from "@/lib/utils";
import type { Environment } from "@/lib/fr-config";
import type { SamlProviderDetail, SamlProviderSummary, SamlCertStatus } from "@/lib/federation/saml";

type SourceMode = "live" | "local";
type DetailTab = "config" | "metadata" | "certs" | "local";

const STATUS_TONE: Record<SamlCertStatus, "success" | "warning" | "danger" | "neutral"> = {
  ok: "success",
  warning: "warning",
  expired: "danger",
  unknown: "neutral",
};

function certStatusLabel(status: SamlCertStatus): string {
  if (status === "expired") return "expired/critical";
  return status;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function jsonBlock(value: unknown): string {
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}

function formatXml(xml: string | null | undefined): string {
  const text = xml?.trim();
  if (!text) return "";

  const normalized = text.replace(/>\s*</g, ">\n<");
  const lines = normalized.split(/\r?\n/);
  let depth = 0;

  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return "";

    if (/^<\//.test(trimmed)) depth = Math.max(depth - 1, 0);
    const formatted = `${"  ".repeat(depth)}${trimmed}`;
    const opensElement = /^<[^!?/][^>]*>$/.test(trimmed);
    const selfClosing = /\/>$/.test(trimmed);
    const closesSameLine = /<\/[^>]+>$/.test(trimmed);
    if (opensElement && !selfClosing && !closesSameLine) depth += 1;
    return formatted;
  }).join("\n");
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length;
}

function tabLabel(tab: DetailTab): string {
  if (tab === "certs") return "Certificates";
  return tab[0].toUpperCase() + tab.slice(1);
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

export function FederationSamlConsole({ environments }: { environments: Environment[] }) {
  const [environment, setEnvironment] = useState(environments[0]?.name ?? "");
  const [realms, setRealms] = useState<string[]>(["alpha"]);
  const [realm, setRealm] = useState("alpha");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceMode>("live");
  const [providers, setProviders] = useState<SamlProviderSummary[]>([]);
  const [selected, setSelected] = useState<SamlProviderSummary | null>(null);
  const [detail, setDetail] = useState<SamlProviderDetail | null>(null);
  const [tab, setTab] = useState<DetailTab>("config");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeEnv = environments.find((e) => e.name === environment) ?? null;

  const loadRealms = useCallback(async () => {
    if (!environment) return;
    const res = await fetch(`/api/federation/saml/realms?environment=${encodeURIComponent(environment)}`);
    if (!res.ok) return;
    const body = await res.json() as { realms?: string[] };
    const next = body.realms?.length ? body.realms : ["alpha"];
    setRealms(next);
    setRealm((cur) => next.includes(cur) ? cur : next[0]);
  }, [environment]);

  const loadProviders = useCallback(async () => {
    if (!environment || !realm) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        environment,
        realm,
        query,
        source,
        pageSize: "100",
      });
      const res = await fetch(`/api/federation/saml/providers?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({})) as { providers?: SamlProviderSummary[]; error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const next = body.providers ?? [];
      setProviders(next);
      setSelected((cur) => {
        if (!cur) return next[0] ?? null;
        return next.find((p) => p.id === cur.id && p.location === cur.location) ?? next[0] ?? null;
      });
    } catch (err) {
      setProviders([]);
      setSelected(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [environment, realm, query, source]);

  const loadDetail = useCallback(async (provider: SamlProviderSummary | null) => {
    if (!provider || !environment) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const params = new URLSearchParams({
        environment,
        realm: provider.realm,
        location: provider.location,
        id: provider.id,
        entityId: provider.entityId,
        source,
      });
      const res = await fetch(`/api/federation/saml/provider?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({})) as { provider?: SamlProviderDetail; error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDetail(body.provider ?? null);
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }, [environment, source]);

  useEffect(() => {
    void loadRealms();
  }, [loadRealms]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    void loadDetail(selected);
  }, [selected, loadDetail]);

  const counts = useMemo(() => ({
    ok: providers.filter((p) => p.metadataCertStatus === "ok").length,
    warning: providers.filter((p) => p.metadataCertStatus === "warning").length,
    expired: providers.filter((p) => p.metadataCertStatus === "expired").length,
    unknown: providers.filter((p) => p.metadataCertStatus === "unknown").length,
  }), [providers]);

  if (environments.length === 0) {
    return (
      <div className="card-padded text-center text-sm text-slate-400">
        No environments configured.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <section className="card-padded space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="label-xs">Environment</span>
            <select
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white min-w-44"
            >
              {environments.map((env) => (
                <option key={env.name} value={env.name}>{env.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="label-xs">Realm</span>
            <select
              value={realm}
              onChange={(e) => setRealm(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white min-w-32"
            >
              {realms.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="space-y-1 flex-1 min-w-64">
            <span className="label-xs">Search entity ID</span>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Contains..."
                className="w-full border border-slate-300 rounded-md pl-8 pr-2 py-1.5 text-sm"
              />
            </div>
          </label>
          <label className="space-y-1">
            <span className="label-xs">Source</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as SourceMode)}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white"
            >
              <option value="live">Live AIC</option>
              <option value="local">Pulled config</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => loadProviders()}
            disabled={loading}
            className="btn-primary inline-flex items-center gap-2"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {activeEnv && <EnvironmentBadge env={activeEnv} />}
          <span>{providers.length} provider{providers.length === 1 ? "" : "s"}</span>
          <span>{counts.ok} ok</span>
          <span>{counts.warning} warning</span>
          <span>{counts.expired} expired/critical</span>
          <span>{counts.unknown} unknown</span>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.85fr)] gap-4">
        <section className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="section-title">Entity providers</h2>
            {loading && <span className="text-xs text-slate-400">Loading...</span>}
          </div>
          <div className="overflow-auto max-h-[650px]">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Entity ID</th>
                  <th className="text-left px-3 py-2 font-semibold">Type</th>
                  <th className="text-left px-3 py-2 font-semibold">Cert</th>
                  <th className="text-left px-3 py-2 font-semibold">Expires</th>
                  <th className="text-left px-3 py-2 font-semibold">Local</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {providers.map((provider) => {
                  const firstCert = provider.metadataCerts[0];
                  const active = selected?.id === provider.id && selected?.location === provider.location;
                  return (
                    <tr
                      key={`${provider.location}:${provider.id}:${provider.entityId}`}
                      onClick={() => { setSelected(provider); setTab("config"); }}
                      className={cn("cursor-pointer hover:bg-slate-50", active && "bg-indigo-50/70")}
                    >
                      <td className="px-4 py-2 align-top">
                        <div className="font-medium text-slate-800 break-all">{provider.entityId}</div>
                        <div className="text-[11px] font-mono text-slate-400 break-all">{provider.id}</div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className="font-mono text-xs text-slate-600">{provider.location}</span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <StatusPill tone={STATUS_TONE[provider.metadataCertStatus]}>
                          {certStatusLabel(provider.metadataCertStatus)}
                        </StatusPill>
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-slate-600 whitespace-nowrap">
                        {firstCert ? (
                          <>
                            <div>{fmtDate(firstCert.validTo)}</div>
                            <div className="text-slate-400">{firstCert.daysRemaining}d</div>
                          </>
                        ) : "n/a"}
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-slate-500">
                        {provider.localPath ? "yes" : "no"}
                      </td>
                    </tr>
                  );
                })}
                {providers.length === 0 && !loading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-sm text-slate-400">
                      No SAML entity providers found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card overflow-hidden min-h-[520px]">
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="section-title">Provider detail</h2>
                <p className="text-xs text-slate-500 mt-1 break-all">
                  {selected ? selected.entityId : "Select a provider"}
                </p>
              </div>
              {selected && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-slate-600">{selected.location}</span>
                  <StatusPill tone={STATUS_TONE[selected.metadataCertStatus]}>
                    {certStatusLabel(selected.metadataCertStatus)}
                  </StatusPill>
                </div>
              )}
            </div>
          </div>
          {selected ? (
            <div className="flex flex-col h-full min-h-0">
              <div className="flex gap-5 px-4 border-b border-slate-100 overflow-x-auto">
                {(["config", "metadata", "certs", "local"] as DetailTab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cn(
                      "py-2.5 border-b-2 text-sm font-medium whitespace-nowrap transition-colors",
                      tab === t
                        ? "border-slate-900 text-slate-900"
                        : "border-transparent text-slate-500 hover:text-slate-900",
                    )}
                  >
                    {tabLabel(t)}
                  </button>
                ))}
              </div>
              <div className="p-4 min-h-0 flex-1 overflow-auto">
                {detailLoading ? (
                  <div className="text-sm text-slate-400">Loading detail...</div>
                ) : tab === "config" ? (
                  <ConfigPanel detail={detail} />
                ) : tab === "metadata" ? (
                  <CodePanel
                    title="SAML metadata XML"
                    value={formatXml(detail?.metadata)}
                    empty="No metadata available."
                  />
                ) : tab === "certs" ? (
                  <CertPanel detail={detail} />
                ) : (
                  <LocalPanel detail={detail} source={source} />
                )}
              </div>
            </div>
          ) : (
            <div className="p-8 text-sm text-slate-400">No provider selected.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function FieldRows({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="divide-y divide-slate-100 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0">
          <dt className="text-xs text-slate-500">{row.label}</dt>
          <dd className="min-w-0 overflow-hidden text-slate-800">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CodePanel({ title, value, empty }: { title: string; value: string; empty: string }) {
  const [copied, setCopied] = useState(false);
  const content = value.trim() ? value : empty;
  const lines = value.trim() ? lineCount(value) : 0;

  const copyContent = async () => {
    if (!value.trim()) return;
    await copyText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="text-sm font-medium text-slate-800">{title}</div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-slate-500">{lines ? `${lines} lines` : "empty"}</div>
          <button
            type="button"
            onClick={copyContent}
            disabled={!value.trim()}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="code-mono max-h-[560px] overflow-auto whitespace-pre bg-white p-3 text-xs leading-5 text-slate-800">
        {content}
      </pre>
    </div>
  );
}

function ConfigPanel({ detail }: { detail: SamlProviderDetail | null }) {
  if (!detail) return <div className="text-sm text-slate-400">No provider detail loaded.</div>;
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <FieldRows
          rows={[
            { label: "Entity ID", value: <span className="break-all">{detail.entityId}</span> },
            { label: "Provider ID", value: <span className="code-mono break-all text-xs">{detail.id}</span> },
            { label: "Type", value: <span className="code-mono text-xs">{detail.location}</span> },
            { label: "Realm", value: <span className="code-mono text-xs">{detail.realm}</span> },
            { label: "Local file", value: detail.localPath ? "Matched" : "Not found" },
          ]}
        />
      </div>
      <CodePanel title="Provider configuration JSON" value={jsonBlock(detail.config)} empty="No configuration available." />
    </div>
  );
}

function CertPanel({ detail }: { detail: SamlProviderDetail | null }) {
  const certs = detail?.metadataCerts ?? [];
  if (certs.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-8 text-center text-sm text-slate-500">
        No X509 certificates found in metadata.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <FieldRows
          rows={[
            {
              label: "Overall",
              value: (
                <StatusPill tone={STATUS_TONE[detail?.metadataCertStatus ?? "unknown"]}>
                  {certStatusLabel(detail?.metadataCertStatus ?? "unknown")}
                </StatusPill>
              ),
            },
            { label: "Certificates", value: `${certs.length}` },
          ]}
        />
      </div>

      {certs.map((cert, index) => (
        <div key={cert.fingerprint256} className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
            <div className="text-sm font-medium text-slate-800">Certificate {index + 1}</div>
            <div className="flex items-center gap-2">
              <StatusPill tone={STATUS_TONE[cert.status]}>{certStatusLabel(cert.status)}</StatusPill>
              <span className="text-xs text-slate-500">{cert.daysRemaining} days remaining</span>
            </div>
          </div>
          <div className="p-3">
            <FieldRows
              rows={[
                { label: "Subject", value: <span className="break-all">{cert.subject}</span> },
                { label: "Issuer", value: <span className="break-all">{cert.issuer}</span> },
                { label: "Valid from", value: fmtDate(cert.validFrom) },
                { label: "Valid to", value: fmtDate(cert.validTo) },
                { label: "SHA-256", value: <span className="code-mono break-all text-xs">{cert.fingerprint256}</span> },
              ]}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function LocalPanel({ detail, source }: { detail: SamlProviderDetail | null; source: SourceMode }) {
  if (!detail) return <div className="text-sm text-slate-400">No provider detail loaded.</div>;
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <FieldRows
        rows={[
          { label: "Current source", value: source === "live" ? "Live AIC" : "Pulled config" },
          {
            label: "Pulled file",
            value: detail.localPath
              ? <span className="code-mono break-all text-xs">{detail.localPath}</span>
              : <span className="text-slate-500">No matching pulled provider file yet.</span>,
          },
          { label: "Local match", value: detail.hasLocalConfig || detail.localPath ? "Yes" : "No" },
        ]}
      />
    </div>
  );
}
