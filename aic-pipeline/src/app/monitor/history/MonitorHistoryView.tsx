"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import type { MonitorGroup, MonitorStatus, MonitorsFile, MonitorTarget } from "@/lib/monitors/types";
import type { TlsGroup, TlsMonitorsFile, TlsStatus, TlsTarget } from "@/lib/monitors/tls-types";

type Kind = "server" | "tls";

interface ServerBucket {
    ts: number;
    okCount: number;
    degradedCount: number;
    downCount: number;
    unknownCount: number;
    status: MonitorStatus;
    p50: number | null;
    p95: number | null;
    avg: number | null;
    samples: number;
}

interface TlsBucket {
    ts: number;
    status: TlsStatus;
    daysRemaining: number | null;
    samples: number;
}

interface ServerHistoryResponse {
    kind: "server";
    targetId: string;
    from: number;
    to: number;
    bucketMs: number;
    points: ServerBucket[];
    availability: { ok: number; degraded: number; down: number; unknown: number; total: number };
}

interface TlsHistoryResponse {
    kind: "tls";
    targetId: string;
    from: number;
    to: number;
    bucketMs: number;
    points: TlsBucket[];
}

const RANGES: { label: string; hours: number }[] = [
    { label: "1h", hours: 1 },
    { label: "6h", hours: 6 },
    { label: "24h", hours: 24 },
    { label: "7d", hours: 24 * 7 },
    { label: "30d", hours: 24 * 30 },
];

function statusToColor(status: MonitorStatus | TlsStatus | "empty"): string {
    switch (status) {
        case "ok":
            return "#10b981"; // emerald-500
        case "degraded":
        case "warning":
            return "#f59e0b"; // amber-500
        case "down":
        case "expired":
        case "error":
            return "#ef4444"; // red-500
        case "unknown":
            return "#94a3b8"; // slate-400
        case "empty":
        default:
            return "#e2e8f0"; // slate-200
    }
}

function formatTick(ts: number, hours: number): string {
    const d = new Date(ts);
    if (hours <= 24) {
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function MonitorHistoryView() {
    const [kind, setKind] = useState<Kind>("server");
    const [hours, setHours] = useState<number>(24);
    const [serverCfg, setServerCfg] = useState<MonitorsFile | null>(null);
    const [tlsCfg, setTlsCfg] = useState<TlsMonitorsFile | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [seriesByTarget, setSeriesByTarget] = useState<Record<string, ServerBucket[] | TlsBucket[]>>(
        {},
    );
    const [availabilityByTarget, setAvailabilityByTarget] = useState<
        Record<string, ServerHistoryResponse["availability"]>
    >({});
    const [loading, setLoading] = useState(false);

    // Load configs
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [a, b] = await Promise.all([
                    fetch("/api/monitors", { cache: "no-store" }),
                    fetch("/api/tls-monitors", { cache: "no-store" }),
                ]);
                if (!a.ok) throw new Error(`GET /api/monitors HTTP ${a.status}`);
                if (!b.ok) throw new Error(`GET /api/tls-monitors HTTP ${b.status}`);
                if (cancelled) return;
                setServerCfg((await a.json()) as MonitorsFile);
                setTlsCfg((await b.json()) as TlsMonitorsFile);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const targets = useMemo<
        { id: string; label: string; groupId?: string; enabled: boolean }[]
    >(() => {
        if (kind === "server") {
            return (serverCfg?.monitors ?? []).map((m) => ({
                id: m.id,
                label: m.label,
                groupId: m.groupId,
                enabled: m.enabled !== false,
            }));
        }
        return (tlsCfg?.targets ?? []).map((t) => ({
            id: t.id,
            label: t.label,
            groupId: t.groupId,
            enabled: t.enabled !== false,
        }));
    }, [kind, serverCfg, tlsCfg]);

    const groups = useMemo<(MonitorGroup | TlsGroup)[]>(() => {
        if (kind === "server") return serverCfg?.groups ?? [];
        return tlsCfg?.groups ?? [];
    }, [kind, serverCfg, tlsCfg]);

    const grouped = useMemo(() => {
        const sortedGroups = [...groups].sort((a, b) => a.order - b.order);
        const byId = new Map<string, typeof targets>();
        for (const t of targets) {
            const key = t.groupId ?? "";
            const arr = byId.get(key) ?? [];
            arr.push(t);
            byId.set(key, arr);
        }
        const groupIds = new Set(sortedGroups.map((g) => g.id));
        const ungrouped = targets.filter((t) => !t.groupId || !groupIds.has(t.groupId));
        return {
            groups: sortedGroups.map((g) => ({
                group: g,
                targets: byId.get(g.id) ?? [],
            })),
            ungrouped,
        };
    }, [groups, targets]);

    const loadAll = useCallback(async () => {
        if (targets.length === 0) return;
        setLoading(true);
        setError(null);
        try {
            const results = await Promise.all(
                targets
                    .filter((t) => t.enabled)
                    .map(async (t) => {
                        const url = `/api/monitors/history?kind=${kind}&targetId=${encodeURIComponent(
                            t.id,
                        )}&hours=${hours}`;
                        const res = await fetch(url, { cache: "no-store" });
                        if (!res.ok) throw new Error(`History HTTP ${res.status} for ${t.id}`);
                        const json = (await res.json()) as ServerHistoryResponse | TlsHistoryResponse;
                        return { id: t.id, json };
                    }),
            );
            const series: Record<string, ServerBucket[] | TlsBucket[]> = {};
            const avail: Record<string, ServerHistoryResponse["availability"]> = {};
            for (const r of results) {
                series[r.id] = r.json.points;
                if (r.json.kind === "server") {
                    avail[r.id] = r.json.availability;
                }
            }
            setSeriesByTarget(series);
            setAvailabilityByTarget(avail);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [kind, hours, targets]);

    useEffect(() => {
        void loadAll();
    }, [loadAll]);

    const handleKindChange = (next: Kind) => {
        if (next === kind) return;
        setKind(next);
        setSelected(null);
        setSeriesByTarget({});
        setAvailabilityByTarget({});
    };

    const selectedTargetLabel = selected
        ? targets.find((t) => t.id === selected)?.label ?? selected
        : null;

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
                    <button
                        type="button"
                        onClick={() => handleKindChange("server")}
                        className={`px-3 py-1.5 text-sm ${kind === "server"
                                ? "bg-indigo-600 text-white"
                                : "bg-white text-slate-700 hover:bg-slate-100"
                            }`}
                    >
                        Server Status
                    </button>
                    <button
                        type="button"
                        onClick={() => handleKindChange("tls")}
                        className={`px-3 py-1.5 text-sm border-l border-slate-300 ${kind === "tls"
                                ? "bg-indigo-600 text-white"
                                : "bg-white text-slate-700 hover:bg-slate-100"
                            }`}
                    >
                        TLS Expiration
                    </button>
                </div>

                <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
                    {RANGES.map((r, i) => (
                        <button
                            key={r.label}
                            type="button"
                            onClick={() => setHours(r.hours)}
                            className={`px-3 py-1.5 text-sm ${i > 0 ? "border-l border-slate-300" : ""
                                } ${hours === r.hours
                                    ? "bg-slate-800 text-white"
                                    : "bg-white text-slate-700 hover:bg-slate-100"
                                }`}
                        >
                            {r.label}
                        </button>
                    ))}
                </div>

                <button
                    type="button"
                    onClick={() => void loadAll()}
                    disabled={loading}
                    className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                    {loading ? "Loading…" : "Refresh"}
                </button>

                <span className="text-xs text-slate-500">
                    Showing last {hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`} • data
                    persists for 30 days
                </span>
            </div>

            {error && (
                <div className="text-rose-600 text-sm bg-rose-50 border border-rose-200 rounded px-3 py-2">
                    {error}
                </div>
            )}

            {targets.length === 0 && (
                <div className="text-slate-500 text-sm border border-dashed border-slate-300 rounded-lg px-4 py-8 text-center">
                    No {kind === "server" ? "monitors" : "TLS targets"} configured.
                </div>
            )}

            <div className="space-y-6">
                {grouped.groups.map(({ group, targets: ts }) =>
                    ts.length === 0 ? null : (
                        <GroupSection
                            key={group.id}
                            title={group.name}
                            targets={ts}
                            hours={hours}
                            kind={kind}
                            seriesByTarget={seriesByTarget}
                            availabilityByTarget={availabilityByTarget}
                            selected={selected}
                            onSelect={setSelected}
                        />
                    ),
                )}
                {grouped.ungrouped.length > 0 && (
                    <GroupSection
                        title={grouped.groups.length === 0 ? "All targets" : "Ungrouped"}
                        targets={grouped.ungrouped}
                        hours={hours}
                        kind={kind}
                        seriesByTarget={seriesByTarget}
                        availabilityByTarget={availabilityByTarget}
                        selected={selected}
                        onSelect={setSelected}
                    />
                )}
            </div>

            {selected && selectedTargetLabel && (
                <DetailPanel
                    kind={kind}
                    targetId={selected}
                    label={selectedTargetLabel}
                    hours={hours}
                    points={seriesByTarget[selected] ?? []}
                    availability={availabilityByTarget[selected]}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
}

// --- Group section --------------------------------------------------------

function GroupSection(props: {
    title: string;
    targets: { id: string; label: string; enabled: boolean }[];
    hours: number;
    kind: Kind;
    seriesByTarget: Record<string, ServerBucket[] | TlsBucket[]>;
    availabilityByTarget: Record<string, ServerHistoryResponse["availability"]>;
    selected: string | null;
    onSelect: (id: string) => void;
}) {
    const { title, targets, hours, kind, seriesByTarget, availabilityByTarget, selected, onSelect } =
        props;
    return (
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700">
                {title}
            </div>
            <div className="divide-y divide-slate-100">
                {targets.map((t) => (
                    <TargetRow
                        key={t.id}
                        target={t}
                        hours={hours}
                        kind={kind}
                        points={seriesByTarget[t.id] ?? []}
                        availability={availabilityByTarget[t.id]}
                        selected={selected === t.id}
                        onSelect={() => onSelect(t.id)}
                    />
                ))}
            </div>
        </div>
    );
}

// --- One row per target ---------------------------------------------------

function TargetRow(props: {
    target: { id: string; label: string; enabled: boolean };
    hours: number;
    kind: Kind;
    points: ServerBucket[] | TlsBucket[];
    availability?: ServerHistoryResponse["availability"];
    selected: boolean;
    onSelect: () => void;
}) {
    const { target, hours, kind, points, availability, selected, onSelect } = props;
    const enabled = target.enabled;

    let summary: string;
    if (points.length === 0) {
        summary = "no data";
    } else if (kind === "server") {
        const total = availability?.total ?? 0;
        const okPct =
            total > 0 ? (((availability?.ok ?? 0) / total) * 100).toFixed(2) + "%" : "—";
        summary = `uptime ${okPct} • ${total} checks`;
    } else {
        const last = points[points.length - 1] as TlsBucket;
        summary =
            last.daysRemaining != null
                ? `${Math.floor(last.daysRemaining)} d remaining`
                : last.status;
    }

    return (
        <button
            type="button"
            onClick={onSelect}
            className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${selected ? "bg-indigo-50" : ""
                } ${enabled ? "" : "opacity-50"}`}
        >
            <div className="flex items-center gap-3 mb-2">
                <div className="text-sm font-medium text-slate-800 flex-1 truncate">{target.label}</div>
                <div className="text-xs text-slate-500">{summary}</div>
            </div>
            {kind === "server" ? (
                <UptimeStrip points={points as ServerBucket[]} hours={hours} />
            ) : (
                <TlsStrip points={points as TlsBucket[]} hours={hours} />
            )}
        </button>
    );
}

// --- Uptime strip (raw SVG) ----------------------------------------------

function UptimeStrip({ points, hours }: { points: ServerBucket[]; hours: number }) {
    const segments = 80;
    const now = Date.now();
    const from = now - hours * 3_600_000;
    const segMs = (now - from) / segments;

    // Aggregate points into N segments by worst status.
    const buckets: (MonitorStatus | "empty")[] = Array(segments).fill("empty");
    for (const p of points) {
        const idx = Math.min(segments - 1, Math.max(0, Math.floor((p.ts - from) / segMs)));
        const prev = buckets[idx];
        const next = p.status;
        buckets[idx] = worstServer(prev, next);
    }

    return (
        <div className="flex gap-[1px] h-3">
            {buckets.map((s, i) => (
                <div
                    key={i}
                    className="flex-1 rounded-[1px]"
                    style={{ backgroundColor: statusToColor(s) }}
                    title={`${new Date(from + i * segMs).toLocaleString()} — ${s}`}
                />
            ))}
        </div>
    );
}

function worstServer(a: MonitorStatus | "empty", b: MonitorStatus): MonitorStatus | "empty" {
    const rank: Record<string, number> = { empty: 0, unknown: 1, ok: 2, degraded: 3, down: 4 };
    return (rank[b] >= rank[a] ? b : a) as MonitorStatus | "empty";
}

// --- TLS strip (color by status, height by days-remaining) ---------------

function TlsStrip({ points, hours }: { points: TlsBucket[]; hours: number }) {
    const segments = 80;
    const now = Date.now();
    const from = now - hours * 3_600_000;
    const segMs = (now - from) / segments;
    const buckets: (TlsBucket | null)[] = Array(segments).fill(null);
    for (const p of points) {
        const idx = Math.min(segments - 1, Math.max(0, Math.floor((p.ts - from) / segMs)));
        buckets[idx] = p;
    }
    return (
        <div className="flex gap-[1px] h-3">
            {buckets.map((b, i) => (
                <div
                    key={i}
                    className="flex-1 rounded-[1px]"
                    style={{ backgroundColor: b ? statusToColor(b.status) : statusToColor("empty") }}
                    title={
                        b
                            ? `${new Date(b.ts).toLocaleString()} — ${b.status}${b.daysRemaining != null
                                ? `, ${Math.floor(b.daysRemaining)} d remaining`
                                : ""
                            }`
                            : `${new Date(from + i * segMs).toLocaleString()} — no data`
                    }
                />
            ))}
        </div>
    );
}

// --- Detail panel (latency / days-remaining chart) ------------------------

function DetailPanel(props: {
    kind: Kind;
    targetId: string;
    label: string;
    hours: number;
    points: ServerBucket[] | TlsBucket[];
    availability?: ServerHistoryResponse["availability"];
    onClose: () => void;
}) {
    const { kind, label, hours, points, availability, onClose } = props;

    const chartData = useMemo(() => {
        if (kind === "server") {
            return (points as ServerBucket[]).map((p) => ({
                ts: p.ts,
                p50: p.p50,
                p95: p.p95,
                avg: p.avg,
            }));
        }
        return (points as TlsBucket[]).map((p) => ({
            ts: p.ts,
            daysRemaining: p.daysRemaining,
        }));
    }, [kind, points]);

    return (
        <div className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
            <div className="flex items-center gap-3">
                <div className="text-sm font-semibold text-slate-800 flex-1 truncate">
                    {label}
                    <span className="text-xs text-slate-500 ml-2">
                        last {hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`}
                    </span>
                </div>
                {kind === "server" && availability && availability.total > 0 && (
                    <div className="flex items-center gap-3 text-xs">
                        <Stat label="ok" value={availability.ok} color="text-emerald-600" />
                        <Stat
                            label="degraded"
                            value={availability.degraded}
                            color="text-amber-600"
                        />
                        <Stat label="down" value={availability.down} color="text-rose-600" />
                        <Stat label="unknown" value={availability.unknown} color="text-slate-500" />
                        <Stat label="checks" value={availability.total} color="text-slate-700" />
                    </div>
                )}
                <button
                    type="button"
                    onClick={onClose}
                    className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                    Close
                </button>
            </div>

            <div className="h-64">
                {chartData.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-slate-500">
                        No history yet — checks made in the Status tab will appear here.
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                            <XAxis
                                dataKey="ts"
                                tickFormatter={(v: number) => formatTick(v, hours)}
                                tick={{ fontSize: 11, fill: "#64748b" }}
                                stroke="#cbd5e1"
                                domain={["dataMin", "dataMax"]}
                                type="number"
                            />
                            <YAxis
                                tick={{ fontSize: 11, fill: "#64748b" }}
                                stroke="#cbd5e1"
                                width={40}
                                label={{
                                    value: kind === "server" ? "ms" : "days",
                                    angle: -90,
                                    position: "insideLeft",
                                    offset: 10,
                                    style: { fontSize: 11, fill: "#64748b" },
                                }}
                            />
                            <Tooltip
                                labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                                contentStyle={{ fontSize: 12 }}
                            />
                            {kind === "server" ? (
                                <>
                                    <Line
                                        type="monotone"
                                        dataKey="p50"
                                        stroke="#10b981"
                                        strokeWidth={1.5}
                                        dot={false}
                                        connectNulls
                                        name="p50 latency"
                                    />
                                    <Line
                                        type="monotone"
                                        dataKey="p95"
                                        stroke="#f59e0b"
                                        strokeWidth={1.5}
                                        dot={false}
                                        connectNulls
                                        name="p95 latency"
                                    />
                                </>
                            ) : (
                                <Line
                                    type="monotone"
                                    dataKey="daysRemaining"
                                    stroke="#6366f1"
                                    strokeWidth={1.5}
                                    dot={false}
                                    connectNulls
                                    name="days remaining"
                                />
                            )}
                        </LineChart>
                    </ResponsiveContainer>
                )}
            </div>
        </div>
    );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <span className="inline-flex items-baseline gap-1">
            <span className={`font-semibold ${color}`}>{value}</span>
            <span className="text-slate-500">{label}</span>
        </span>
    );
}

// Avoid unused-import warnings for type re-exports.
export type _ReExports = MonitorTarget | TlsTarget;
