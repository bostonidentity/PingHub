"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { REFRESH_INTERVAL_OPTIONS } from "@/lib/monitors/refresh-intervals";
import type {
    TlsCheckResult,
    TlsGroup,
    TlsMonitorsFile,
    TlsStatus,
    TlsTarget,
} from "@/lib/monitors/tls-types";
import { usePersistentState } from "@/hooks/usePersistentState";

import { TlsConfigEditor } from "./TlsConfigEditor";

export function TlsStatusView() {
    const [config, setConfig] = useState<TlsMonitorsFile | null>(null);
    const [results, setResults] = usePersistentState<Record<string, TlsCheckResult>>(
        "monitor.tls.results",
        {},
    );
    const [running, setRunning] = useState<Set<string>>(new Set());
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [autoRefresh, setAutoRefresh] = usePersistentState<boolean>("monitor.tls.autoRefresh", false);
    const [intervalSec, setIntervalSec] = usePersistentState<number>(
        "monitor.tls.intervalSec",
        // TLS doesn't change often — default to daily.
        86400,
    );
    const [selected, setSelected] = useState<string | null>(null);

    const checkAllRef = useRef<() => void>(() => { });

    const loadConfig = useCallback(async () => {
        try {
            const res = await fetch("/api/tls-monitors", { cache: "no-store" });
            if (!res.ok) throw new Error(`GET /api/tls-monitors HTTP ${res.status}`);
            setConfig((await res.json()) as TlsMonitorsFile);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    const runChecks = useCallback(
        async (id?: string) => {
            const targets = id
                ? (config?.targets ?? []).filter((t) => t.id === id)
                : (config?.targets ?? []).filter((t) => t.enabled !== false);
            if (targets.length === 0) return;
            setRunning((prev) => {
                const next = new Set(prev);
                for (const t of targets) next.add(t.id);
                return next;
            });
            try {
                const res = await fetch("/api/tls-monitors/check", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(id ? { id } : {}),
                });
                if (!res.ok) throw new Error(`POST /api/tls-monitors/check HTTP ${res.status}`);
                const json = (await res.json()) as { results: TlsCheckResult[] };
                setResults((prev) => {
                    const next = { ...prev };
                    for (const r of json.results) next[r.id] = r;
                    return next;
                });
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setRunning((prev) => {
                    const next = new Set(prev);
                    for (const t of targets) next.delete(t.id);
                    return next;
                });
            }
        },
        [config, setResults],
    );

    useEffect(() => {
        void loadConfig();
    }, [loadConfig]);

    checkAllRef.current = () => {
        if (running.size > 0) return;
        void runChecks();
    };

    useEffect(() => {
        if (!autoRefresh) return;
        const id = setInterval(() => checkAllRef.current(), intervalSec * 1000);
        return () => clearInterval(id);
    }, [autoRefresh, intervalSec]);

    const saveConfig = useCallback(
        async (next: TlsMonitorsFile) => {
            const res = await fetch("/api/tls-monitors", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(next),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `PUT /api/tls-monitors HTTP ${res.status}`);
            }
            setConfig((await res.json()) as TlsMonitorsFile);
            setEditing(false);
        },
        [],
    );

    const grouped = useMemo(() => {
        if (!config) return [];
        const byGroup = new Map<string, TlsTarget[]>();
        for (const t of config.targets) {
            const key = t.groupId ?? "";
            const arr = byGroup.get(key) ?? [];
            arr.push(t);
            byGroup.set(key, arr);
        }
        return [...config.groups]
            .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
            .map((g) => ({
                group: g,
                targets: (byGroup.get(g.id) ?? []).slice().sort((a, b) => a.label.localeCompare(b.label)),
            }));
    }, [config]);

    const ungrouped = useMemo(() => {
        if (!config) return [];
        const groupIds = new Set(config.groups.map((g) => g.id));
        return config.targets.filter((t) => !t.groupId || !groupIds.has(t.groupId));
    }, [config]);

    if (!config) {
        return (
            <div className="text-slate-500 text-sm py-8">
                {error ? <span className="text-rose-600">{error}</span> : "Loading TLS targets…"}
            </div>
        );
    }

    if (editing) {
        return (
            <TlsConfigEditor
                initial={config}
                onCancel={() => setEditing(false)}
                onSave={saveConfig}
            />
        );
    }

    const enabledTargets = config.targets.filter((t) => t.enabled !== false);
    const totalEnabled = enabledTargets.length;
    const allRunning = running.size > 0;
    const enabledIds = new Set(enabledTargets.map((t) => t.id));
    const enabledResults = Object.values(results).filter((r) => enabledIds.has(r.id));

    const lastCheckedAt = enabledResults.reduce<string | null>((acc, r) => {
        if (!acc || r.checkedAt > acc) return r.checkedAt;
        return acc;
    }, null);

    const summaryStatus: TlsStatus = enabledResults.some((r) => r.status === "expired" || r.status === "error")
        ? enabledResults.some((r) => r.status === "expired")
            ? "expired"
            : "error"
        : enabledResults.some((r) => r.status === "warning")
            ? "warning"
            : enabledResults.length > 0 && enabledResults.every((r) => r.status === "ok")
                ? "ok"
                : "unknown";

    const counts = {
        ok: enabledResults.filter((r) => r.status === "ok").length,
        warning: enabledResults.filter((r) => r.status === "warning").length,
        expired: enabledResults.filter((r) => r.status === "expired").length,
        error: enabledResults.filter((r) => r.status === "error").length,
        unknown: totalEnabled - enabledResults.length,
    };

    const critical = enabledResults.filter((r) => r.status === "expired" || r.status === "error");
    const warnings = enabledResults.filter((r) => r.status === "warning");
    const targetById = new Map(config.targets.map((t) => [t.id, t]));

    return (
        <div className="space-y-4">
            {error && (
                <div className="text-rose-600 text-sm bg-rose-50 border border-rose-200 rounded px-3 py-2">
                    {error}
                </div>
            )}

            {critical.length > 0 && (
                <div
                    role="alert"
                    className="border border-rose-300 bg-rose-50 rounded-lg px-3 py-2 text-sm text-rose-800"
                >
                    <div className="flex items-center gap-2 font-semibold">
                        <span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500 animate-pulse" />
                        TLS certificate issue
                        <span className="font-normal text-rose-700">({critical.length})</span>
                    </div>
                    <ul className="mt-1 ml-5 list-disc text-xs text-rose-700 space-y-0.5">
                        {critical.map((r) => {
                            const t = targetById.get(r.id);
                            return (
                                <li key={r.id}>
                                    <button
                                        type="button"
                                        onClick={() => setSelected(r.id)}
                                        className="underline hover:text-rose-900"
                                    >
                                        {t?.label ?? r.id}
                                    </button>
                                    <span className="text-rose-600"> — {r.message}</span>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            <div className="flex items-center gap-3 flex-wrap border border-slate-200 bg-slate-50/60 rounded-lg px-3 py-2 text-sm">
                <TlsStatusDot status={summaryStatus} pulse={allRunning} className="!w-3 !h-3" />
                <span className="font-medium text-slate-700">
                    {summaryStatus === "unknown" ? "Not checked yet" : `Overall: ${labelFor(summaryStatus)}`}
                </span>
                <span className="text-xs text-slate-500">
                    {counts.ok} ok · {counts.warning} warning · {counts.expired} expired/critical · {counts.error} error
                    {counts.unknown > 0 && ` · ${counts.unknown} unknown`}
                </span>
                <div className="flex-1" />
                <span className="text-xs text-slate-500">
                    {lastCheckedAt ? (
                        <>
                            Last checked{" "}
                            <span title={new Date(lastCheckedAt).toLocaleString()}>{formatAgo(lastCheckedAt)}</span>
                        </>
                    ) : (
                        "No checks yet"
                    )}
                </span>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
                <button
                    type="button"
                    onClick={() => runChecks()}
                    disabled={allRunning || totalEnabled === 0}
                    className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300"
                >
                    {allRunning ? "Checking…" : `Check all (${totalEnabled})`}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none">
                    <input
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(e) => setAutoRefresh(e.target.checked)}
                        className="rounded"
                    />
                    Auto-refresh
                </label>
                <select
                    value={intervalSec}
                    onChange={(e) => setIntervalSec(Number(e.target.value))}
                    disabled={!autoRefresh}
                    className="text-xs border border-slate-300 rounded px-1 py-0.5 disabled:opacity-50"
                >
                    {REFRESH_INTERVAL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            every {opt.label}
                        </option>
                    ))}
                </select>
                <div className="flex-1" />
                <TlsLegend />
                <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                    Edit configuration
                </button>
            </div>

            {config.targets.length === 0 && (
                <div className="text-slate-500 text-sm border border-dashed border-slate-300 rounded-lg px-4 py-8 text-center">
                    No TLS targets configured yet. Click{" "}
                    <span className="font-medium">Edit configuration</span> to add one.
                </div>
            )}

            <div className="space-y-6">
                {grouped.map(({ group, targets }) => (
                    <TlsGroupBlock
                        key={group.id}
                        title={group.name}
                        targets={targets}
                        results={results}
                        running={running}
                        onSelect={setSelected}
                        onRunOne={(id) => runChecks(id)}
                    />
                ))}
                {ungrouped.length > 0 && (
                    <TlsGroupBlock
                        title="Ungrouped"
                        targets={ungrouped}
                        results={results}
                        running={running}
                        onSelect={setSelected}
                        onRunOne={(id) => runChecks(id)}
                    />
                )}
            </div>


            {warnings.length > 0 && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    {warnings.length} certificate(s) expiring soon — see warnings highlighted in the table.
                </div>
            )}

            {selected && results[selected] && (
                <DetailDrawer
                    target={targetById.get(selected)}
                    result={results[selected]}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
}

function labelFor(status: TlsStatus): string {
    if (status === "expired") return "expired / critical";
    return status;
}

interface TlsGroupBlockProps {
    title: string;
    targets: TlsTarget[];
    results: Record<string, TlsCheckResult>;
    running: Set<string>;
    onSelect: (id: string) => void;
    onRunOne: (id: string) => void;
}

function TlsGroupBlock({ title, targets, results, running, onSelect, onRunOne }: TlsGroupBlockProps) {
    if (targets.length === 0) return null;
    return (
        <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2 px-1">
                {title}
            </h2>
            <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                        <tr>
                            <th className="px-3 py-2 text-left w-6"></th>
                            <th className="px-3 py-2 text-left">Target</th>
                            <th className="px-3 py-2 text-left">Host</th>
                            <th className="px-3 py-2 text-left">Expires</th>
                            <th className="px-3 py-2 text-left">Days left</th>
                            <th className="px-3 py-2 text-left">Issuer</th>
                            <th className="px-3 py-2 text-left">Checked</th>
                            <th className="px-3 py-2"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {targets.map((t) => {
                            const r = results[t.id];
                            const status: TlsStatus = t.enabled === false ? "unknown" : r?.status ?? "unknown";
                            const isRunning = running.has(t.id);
                            return (
                                <tr
                                    key={t.id}
                                    className={cn(
                                        "border-t border-slate-200",
                                        t.enabled === false && "opacity-50",
                                    )}
                                >
                                    <td className="px-3 py-2">
                                        <TlsStatusDot status={status} pulse={isRunning} />
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="font-medium text-slate-800">{t.label}</div>
                                        <div className="text-xs text-slate-500 font-mono break-all">{t.url}</div>
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-600 font-mono">
                                        {r ? `${r.host}:${r.port}` : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-600">
                                        {r?.validTo ? new Date(r.validTo).toLocaleDateString() : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-xs">
                                        {r?.daysRemaining === undefined ? (
                                            "—"
                                        ) : r.daysRemaining < 0 ? (
                                            <span className="text-rose-700 font-semibold">
                                                expired {Math.abs(r.daysRemaining)}d ago
                                            </span>
                                        ) : (
                                            <span
                                                className={cn(
                                                    status === "expired" && "text-rose-700 font-semibold",
                                                    status === "warning" && "text-amber-700 font-semibold",
                                                    status === "ok" && "text-emerald-700",
                                                )}
                                            >
                                                {r.daysRemaining}d
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-600 truncate max-w-[180px]" title={r?.issuer}>
                                        {r?.issuer ?? "—"}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-500">
                                        {r ? (
                                            <span title={new Date(r.checkedAt).toLocaleString()}>
                                                {formatAgo(r.checkedAt)}
                                            </span>
                                        ) : (
                                            "—"
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-right whitespace-nowrap">
                                        <button
                                            type="button"
                                            onClick={() => onRunOne(t.id)}
                                            disabled={isRunning || t.enabled === false}
                                            className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50 mr-1"
                                        >
                                            {isRunning ? "…" : "Check"}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onSelect(t.id)}
                                            disabled={!r}
                                            className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50"
                                        >
                                            Details
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function TlsStatusDot({
    status,
    pulse,
    className,
}: {
    status: TlsStatus;
    pulse?: boolean;
    className?: string;
}) {
    const colors: Record<TlsStatus, string> = {
        ok: "bg-emerald-500",
        warning: "bg-amber-500",
        expired: "bg-rose-500",
        error: "bg-rose-500",
        unknown: "bg-slate-300",
    };
    return (
        <span
            className={cn(
                "inline-block w-2.5 h-2.5 rounded-full",
                colors[status],
                pulse && "animate-pulse",
                className,
            )}
            aria-label={status}
        />
    );
}

function TlsLegend() {
    return (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                ok
            </span>
            <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                warning
            </span>
            <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-rose-500" />
                expired / error
            </span>
        </div>
    );
}

function DetailDrawer({
    target,
    result,
    onClose,
}: {
    target?: TlsTarget;
    result: TlsCheckResult;
    onClose: () => void;
}) {
    return (
        <div
            className="fixed inset-0 z-40 bg-black/30 flex justify-end"
            onClick={onClose}
            role="dialog"
        >
            <div
                className="bg-white w-full max-w-xl h-full overflow-y-auto p-5 space-y-3 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-900">
                            {target?.label ?? result.id}
                        </h2>
                        <div className="text-xs text-slate-500 font-mono break-all">{target?.url}</div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-700 text-xl leading-none"
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>

                <Field label="Status" value={result.message} />
                <Field label="Host" value={`${result.host}:${result.port}`} />
                <Field label="Subject" value={result.subject ?? "—"} />
                <Field label="Issuer" value={result.issuer ?? "—"} />
                <Field
                    label="Valid from"
                    value={result.validFrom ? new Date(result.validFrom).toLocaleString() : "—"}
                />
                <Field
                    label="Valid to"
                    value={result.validTo ? new Date(result.validTo).toLocaleString() : "—"}
                />
                <Field
                    label="Days remaining"
                    value={result.daysRemaining === undefined ? "—" : String(result.daysRemaining)}
                />
                <Field label="Serial" value={result.serialNumber ?? "—"} />
                <Field label="SHA-256 fingerprint" value={result.fingerprint256 ?? "—"} mono />
                {result.san && result.san.length > 0 && (
                    <div>
                        <div className="text-xs text-slate-500 mb-1">Subject alternative names</div>
                        <pre className="text-xs bg-slate-50 border border-slate-200 rounded p-2 whitespace-pre-wrap break-all">
                            {result.san.join("\n")}
                        </pre>
                    </div>
                )}
                {result.error && <Field label="Error" value={result.error} />}
                <Field
                    label="Checked at"
                    value={new Date(result.checkedAt).toLocaleString()}
                />
            </div>
        </div>
    );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div>
            <div className="text-xs text-slate-500">{label}</div>
            <div className={cn("text-sm text-slate-800 break-all", mono && "font-mono text-xs")}>
                {value}
            </div>
        </div>
    );
}

function formatAgo(iso: string): string {
    const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}

