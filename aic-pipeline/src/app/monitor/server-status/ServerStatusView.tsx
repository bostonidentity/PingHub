"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type {
    MonitorCheckResult,
    MonitorGroup,
    MonitorStatus,
    MonitorTarget,
    MonitorsFile,
} from "@/lib/monitors/types";
import { REFRESH_INTERVAL_OPTIONS } from "@/lib/monitors/refresh-intervals";
import { usePersistentState } from "@/hooks/usePersistentState";

import { MonitorConfigEditor } from "./MonitorConfigEditor";

export function ServerStatusView() {
    const [config, setConfig] = useState<MonitorsFile | null>(null);
    const [results, setResults] = usePersistentState<Record<string, MonitorCheckResult>>(
        "monitor.serverStatus.results",
        {},
    );
    const [running, setRunning] = useState<Set<string>>(new Set());
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [autoRefresh, setAutoRefresh] = usePersistentState<boolean>("monitor.serverStatus.autoRefresh", false);
    const [intervalSec, setIntervalSec] = usePersistentState<number>("monitor.serverStatus.intervalSec", 30);
    const [selected, setSelected] = useState<string | null>(null);

    const checkAllRef = useRef<() => void>(() => { });

    const loadConfig = useCallback(async () => {
        try {
            const res = await fetch("/api/monitors", { cache: "no-store" });
            if (!res.ok) throw new Error(`GET /api/monitors HTTP ${res.status}`);
            setConfig((await res.json()) as MonitorsFile);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    const runChecks = useCallback(
        async (id?: string) => {
            const monitors = config?.monitors ?? [];
            const targets = id
                ? monitors.filter((m) => m.id === id)
                : monitors.filter((m) => m.enabled !== false);
            if (targets.length === 0) return;
            setRunning((prev) => {
                const next = new Set(prev);
                for (const t of targets) next.add(t.id);
                return next;
            });
            try {
                const res = await fetch("/api/monitors/check", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(id ? { id } : {}),
                });
                if (!res.ok) throw new Error(`POST /api/monitors/check HTTP ${res.status}`);
                const json = (await res.json()) as { results: MonitorCheckResult[] };
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
        [config],
    );

    // Keep a ref so the auto-refresh interval always calls the latest closure
    // (which has the current config).
    checkAllRef.current = () => runChecks();

    useEffect(() => {
        loadConfig();
    }, [loadConfig]);

    useEffect(() => {
        if (!autoRefresh) return;
        const id = setInterval(() => {
            checkAllRef.current();
        }, intervalSec * 1000);
        return () => clearInterval(id);
    }, [autoRefresh, intervalSec]);

    const saveConfig = useCallback(
        async (next: MonitorsFile) => {
            try {
                const res = await fetch("/api/monitors", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(next),
                });
                if (!res.ok) {
                    const json = (await res.json().catch(() => ({}))) as { error?: string };
                    throw new Error(json.error ?? `PUT /api/monitors HTTP ${res.status}`);
                }
                setConfig((await res.json()) as MonitorsFile);
                setEditing(false);
                setError(null);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        },
        [],
    );

    const grouped = useMemo(() => {
        if (!config) return [] as Array<{ group: MonitorGroup; monitors: MonitorTarget[] }>;
        const byGroup = new Map<string, MonitorTarget[]>();
        for (const m of config.monitors) {
            const arr = byGroup.get(m.groupId) ?? [];
            arr.push(m);
            byGroup.set(m.groupId, arr);
        }
        return [...config.groups]
            .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
            .map((g) => ({
                group: g,
                monitors: (byGroup.get(g.id) ?? []).slice().sort((a, b) => a.label.localeCompare(b.label)),
            }));
    }, [config]);

    const ungrouped = useMemo(() => {
        if (!config) return [] as MonitorTarget[];
        const groupIds = new Set(config.groups.map((g) => g.id));
        return config.monitors.filter((m) => !groupIds.has(m.groupId));
    }, [config]);

    if (error && !config) {
        return <div className="text-rose-600 text-sm">Error: {error}</div>;
    }
    if (!config) {
        return <div className="text-slate-500 text-sm">Loading…</div>;
    }

    if (editing) {
        return (
            <MonitorConfigEditor
                config={config}
                onCancel={() => setEditing(false)}
                onSave={saveConfig}
            />
        );
    }

    const totalEnabled = config.monitors.filter((m) => m.enabled !== false).length;
    const allRunning = running.size > 0;

    // Summary: most recent checkedAt across enabled monitors + overall worst status.
    const enabledIds = new Set(config.monitors.filter((m) => m.enabled !== false).map((m) => m.id));
    const enabledResults = Object.values(results).filter((r) => enabledIds.has(r.id));
    const lastCheckedAt = enabledResults.reduce<string | null>((acc, r) => {
        if (!acc || r.checkedAt > acc) return r.checkedAt;
        return acc;
    }, null);
    const summaryStatus: MonitorStatus = enabledResults.some((r) => r.status === "down")
        ? "down"
        : enabledResults.some((r) => r.status === "degraded")
            ? "degraded"
            : enabledResults.length > 0 && enabledResults.every((r) => r.status === "ok")
                ? "ok"
                : "unknown";
    const counts = {
        ok: enabledResults.filter((r) => r.status === "ok").length,
        degraded: enabledResults.filter((r) => r.status === "degraded").length,
        down: enabledResults.filter((r) => r.status === "down").length,
        unknown: totalEnabled - enabledResults.length,
    };

    return (
        <div className="space-y-4">
            {error && (
                <div className="text-rose-600 text-sm bg-rose-50 border border-rose-200 rounded px-3 py-2">
                    {error}
                </div>
            )}

            <div className="flex items-center gap-3 flex-wrap border border-slate-200 bg-slate-50/60 rounded-lg px-3 py-2 text-sm">
                <StatusDot status={summaryStatus} pulse={allRunning} className="!w-3 !h-3" />
                <span className="font-medium text-slate-700">
                    {summaryStatus === "unknown" ? "Not checked yet" : `Overall: ${summaryStatus}`}
                </span>
                <span className="text-xs text-slate-500">
                    {counts.ok} ok · {counts.degraded} degraded · {counts.down} down
                    {counts.unknown > 0 && ` · ${counts.unknown} unknown`}
                </span>
                <div className="flex-1" />
                <span className="text-xs text-slate-500">
                    {lastCheckedAt ? (
                        <>
                            Last checked <span title={new Date(lastCheckedAt).toLocaleString()}>{formatAgo(lastCheckedAt)}</span>
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
                <Legend />
                <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                    Edit configuration
                </button>
            </div>

            {grouped.length === 0 && ungrouped.length === 0 && (
                <div className="text-slate-500 text-sm border border-dashed border-slate-300 rounded-lg px-4 py-8 text-center">
                    No monitors configured yet. Click <span className="font-medium">Edit configuration</span> to add one.
                </div>
            )}

            <div className="space-y-6">
                {grouped.map(({ group, monitors }) => (
                    <GroupBlock
                        key={group.id}
                        title={group.name}
                        monitors={monitors}
                        results={results}
                        running={running}
                        selected={selected}
                        onSelect={setSelected}
                        onRunOne={(id) => runChecks(id)}
                    />
                ))}
                {ungrouped.length > 0 && (
                    <GroupBlock
                        title="Ungrouped"
                        monitors={ungrouped}
                        results={results}
                        running={running}
                        selected={selected}
                        onSelect={setSelected}
                        onRunOne={(id) => runChecks(id)}
                    />
                )}
            </div>

            {selected && (
                <DetailDrawer
                    target={config.monitors.find((m) => m.id === selected) ?? null}
                    result={results[selected] ?? null}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
}

interface GroupBlockProps {
    title: string;
    monitors: MonitorTarget[];
    results: Record<string, MonitorCheckResult>;
    running: Set<string>;
    selected: string | null;
    onSelect: (id: string) => void;
    onRunOne: (id: string) => void;
}

function GroupBlock({ title, monitors, results, running, selected, onSelect, onRunOne }: GroupBlockProps) {
    if (monitors.length === 0) return null;
    return (
        <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2 px-1">
                {title}
            </h2>
            <div className="overflow-hidden border border-slate-200 rounded-lg bg-white">
                <table className="min-w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50/60">
                        <tr>
                            <th className="text-left px-3 py-2 font-medium text-slate-600 w-8"></th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">Label</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">URL</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600 w-28">Result</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600 w-24">Latency</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600 w-32">Checked</th>
                            <th className="text-right px-3 py-2 font-medium text-slate-600 w-24"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {monitors.map((m) => {
                            const r = results[m.id] ?? null;
                            const status: MonitorStatus = r?.status ?? "unknown";
                            const isRunning = running.has(m.id);
                            const isSelected = selected === m.id;
                            const disabled = m.enabled === false;
                            return (
                                <tr
                                    key={m.id}
                                    onClick={() => onSelect(m.id)}
                                    className={cn(
                                        "border-b border-slate-100 last:border-0 cursor-pointer",
                                        isSelected ? "bg-indigo-50/60" : "hover:bg-slate-50/60",
                                        disabled && "opacity-50",
                                    )}
                                >
                                    <td className="px-3 py-2">
                                        <StatusDot status={status} pulse={isRunning} />
                                    </td>
                                    <td className="px-3 py-2 font-medium text-slate-800">{m.label}</td>
                                    <td className="px-3 py-2 font-mono text-xs text-slate-500 truncate max-w-[480px]">
                                        {m.url}
                                    </td>
                                    <td className="px-3 py-2 text-xs">
                                        {r ? (
                                            <span className={cn("font-medium", TEXT[status])}>
                                                {r.httpStatus ? `HTTP ${r.httpStatus}` : r.message}
                                            </span>
                                        ) : (
                                            <span className="text-slate-400">—</span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-600">
                                        {r ? `${r.latencyMs}ms` : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-500">
                                        {r ? formatAgo(r.checkedAt) : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onRunOne(m.id);
                                            }}
                                            disabled={isRunning || disabled}
                                            className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                                        >
                                            {isRunning ? "…" : "Check"}
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

function DetailDrawer({
    target,
    result,
    onClose,
}: {
    target: MonitorTarget | null;
    result: MonitorCheckResult | null;
    onClose: () => void;
}) {
    if (!target) return null;
    return (
        <div className="fixed inset-0 z-40 flex" role="dialog">
            <div
                className="absolute inset-0 bg-slate-900/40"
                onClick={onClose}
                aria-hidden="true"
            />
            <div className="ml-auto h-full w-full max-w-lg bg-white shadow-xl flex flex-col relative">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                    <div>
                        <div className="text-sm font-semibold text-slate-900">{target.label}</div>
                        <div className="text-xs text-slate-500 font-mono break-all">{target.url}</div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 text-xl leading-none"
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>
                <div className="flex-1 overflow-auto p-4 space-y-4 text-sm">
                    {result ? (
                        <>
                            <Field label="Status">
                                <span className={cn("font-medium capitalize", TEXT[result.status])}>
                                    {result.status}
                                </span>
                            </Field>
                            <Field label="Message">{result.message}</Field>
                            <Field label="HTTP status">{result.httpStatus ?? "—"}</Field>
                            <Field label="Latency">{result.latencyMs}ms</Field>
                            <Field label="Checked">
                                {new Date(result.checkedAt).toLocaleString()}
                            </Field>
                            {result.error && <Field label="Error">{result.error}</Field>}
                            {result.bodySnippet && (
                                <div>
                                    <div className="text-xs font-medium text-slate-500 mb-1">Response body</div>
                                    <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded p-2 whitespace-pre-wrap break-all max-h-72 overflow-auto">
                                        {result.bodySnippet}
                                    </pre>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="text-slate-500">No result yet — click Check to run.</div>
                    )}
                </div>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex gap-3">
            <div className="text-xs font-medium text-slate-500 w-24 shrink-0">{label}</div>
            <div className="text-sm text-slate-800 break-all">{children}</div>
        </div>
    );
}

const DOT: Record<MonitorStatus, string> = {
    ok: "bg-emerald-500",
    degraded: "bg-amber-500",
    down: "bg-rose-500",
    unknown: "bg-slate-300",
};
const RING: Record<MonitorStatus, string> = {
    ok: "ring-emerald-200",
    degraded: "ring-amber-200",
    down: "ring-rose-200",
    unknown: "ring-slate-200",
};
const TEXT: Record<MonitorStatus, string> = {
    ok: "text-emerald-700",
    degraded: "text-amber-700",
    down: "text-rose-700",
    unknown: "text-slate-500",
};

function StatusDot({ status, pulse, className }: { status: MonitorStatus; pulse?: boolean; className?: string }) {
    return (
        <span
            className={cn(
                "inline-block w-2.5 h-2.5 rounded-full ring-2",
                DOT[status],
                RING[status],
                pulse && "animate-pulse",
                className,
            )}
        />
    );
}

function Legend() {
    return (
        <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
                <StatusDot status="ok" />
                ok
            </span>
            <span className="flex items-center gap-1.5">
                <StatusDot status="degraded" />
                degraded
            </span>
            <span className="flex items-center gap-1.5">
                <StatusDot status="down" />
                down
            </span>
            <span className="flex items-center gap-1.5">
                <StatusDot status="unknown" />
                unknown
            </span>
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
