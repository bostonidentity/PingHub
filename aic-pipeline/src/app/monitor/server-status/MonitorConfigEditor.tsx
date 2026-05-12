"use client";

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type {
    MonitorAuthKind,
    MonitorGroup,
    MonitorTarget,
    MonitorsFile,
} from "@/lib/monitors/types";

interface Props {
    config: MonitorsFile;
    onCancel: () => void;
    onSave: (next: MonitorsFile) => void;
}

const AUTH_KINDS: MonitorAuthKind[] = ["none", "basic", "bearer"];

export function MonitorConfigEditor({ config, onCancel, onSave }: Props) {
    const [groups, setGroups] = useState<MonitorGroup[]>(() => structuredClone(config.groups));
    const [monitors, setMonitors] = useState<MonitorTarget[]>(() => structuredClone(config.monitors));
    const [activeGroupId, setActiveGroupId] = useState<string | null>(
        () => config.groups[0]?.id ?? null,
    );
    const [error, setError] = useState<string | null>(null);

    const monitorsByGroup = useMemo(() => {
        const m = new Map<string, MonitorTarget[]>();
        for (const t of monitors) {
            const arr = m.get(t.groupId) ?? [];
            arr.push(t);
            m.set(t.groupId, arr);
        }
        return m;
    }, [monitors]);

    function addGroup() {
        const name = window.prompt("Group name (e.g. AM, IG, SSO):");
        if (!name) return;
        const id = makeId();
        const order = groups.length;
        setGroups((prev) => [...prev, { id, name, order }]);
        setActiveGroupId(id);
    }

    function renameGroup(id: string) {
        const g = groups.find((x) => x.id === id);
        if (!g) return;
        const name = window.prompt("New group name:", g.name);
        if (!name) return;
        setGroups((prev) => prev.map((x) => (x.id === id ? { ...x, name } : x)));
    }

    function deleteGroup(id: string) {
        const inUse = monitors.some((m) => m.groupId === id);
        if (inUse) {
            const ok = window.confirm("Group has monitors. Delete the group AND its monitors?");
            if (!ok) return;
            setMonitors((prev) => prev.filter((m) => m.groupId !== id));
        }
        setGroups((prev) => prev.filter((g) => g.id !== id));
        if (activeGroupId === id) setActiveGroupId(groups[0]?.id ?? null);
    }

    function moveGroup(id: string, dir: -1 | 1) {
        setGroups((prev) => {
            const sorted = [...prev].sort((a, b) => a.order - b.order);
            const idx = sorted.findIndex((g) => g.id === id);
            const swapIdx = idx + dir;
            if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return prev;
            const a = sorted[idx];
            const b = sorted[swapIdx];
            return prev.map((g) => {
                if (g.id === a.id) return { ...g, order: b.order };
                if (g.id === b.id) return { ...g, order: a.order };
                return g;
            });
        });
    }

    function addMonitor() {
        if (!activeGroupId) {
            setError("Create at least one group first.");
            return;
        }
        const target: MonitorTarget = {
            id: makeId(),
            groupId: activeGroupId,
            label: "New monitor",
            url: "https://",
            method: "GET",
            timeoutMs: 5000,
            insecureTls: true,
            auth: { kind: "none" },
            enabled: true,
        };
        setMonitors((prev) => [...prev, target]);
    }

    function updateMonitor(id: string, patch: Partial<MonitorTarget>) {
        setMonitors((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    }

    function deleteMonitor(id: string) {
        setMonitors((prev) => prev.filter((m) => m.id !== id));
    }

    function handleSave() {
        // Basic validation
        if (groups.length === 0 && monitors.length > 0) {
            setError("Add at least one group.");
            return;
        }
        for (const m of monitors) {
            if (!m.label.trim()) return setError("Every monitor needs a label.");
            try {
                new URL(m.url);
            } catch {
                return setError(`Invalid URL: ${m.label}`);
            }
        }
        setError(null);
        onSave({ groups, monitors });
    }

    const sortedGroups = [...groups].sort((a, b) => a.order - b.order);
    const activeMonitors = activeGroupId ? monitorsByGroup.get(activeGroupId) ?? [] : [];

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={handleSave}
                    className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
                >
                    Save
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                    Cancel
                </button>
                <div className="text-xs text-slate-500">
                    Config is stored in <span className="font-mono">environments/monitors.json</span>.
                </div>
            </div>
            {error && (
                <div className="text-rose-600 text-sm bg-rose-50 border border-rose-200 rounded px-3 py-2">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-[220px_1fr] gap-4">
                {/* Group list */}
                <aside className="border border-slate-200 rounded-lg bg-white">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Groups
                        </span>
                        <button
                            type="button"
                            onClick={addGroup}
                            className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
                        >
                            + Add
                        </button>
                    </div>
                    <ul className="py-1">
                        {sortedGroups.length === 0 && (
                            <li className="px-3 py-2 text-xs text-slate-500">No groups yet.</li>
                        )}
                        {sortedGroups.map((g) => {
                            const count = monitorsByGroup.get(g.id)?.length ?? 0;
                            const active = activeGroupId === g.id;
                            return (
                                <li key={g.id}>
                                    <div
                                        className={cn(
                                            "group flex items-center gap-1 px-2 py-1.5 cursor-pointer text-sm",
                                            active ? "bg-indigo-50 text-indigo-700" : "hover:bg-slate-50",
                                        )}
                                        onClick={() => setActiveGroupId(g.id)}
                                    >
                                        <span className="flex-1 truncate">{g.name}</span>
                                        <span className="text-xs text-slate-400">{count}</span>
                                        <div className="opacity-0 group-hover:opacity-100 flex">
                                            <button
                                                type="button"
                                                title="Move up"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    moveGroup(g.id, -1);
                                                }}
                                                className="px-1 text-slate-500 hover:text-slate-800"
                                            >
                                                ↑
                                            </button>
                                            <button
                                                type="button"
                                                title="Move down"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    moveGroup(g.id, 1);
                                                }}
                                                className="px-1 text-slate-500 hover:text-slate-800"
                                            >
                                                ↓
                                            </button>
                                            <button
                                                type="button"
                                                title="Rename"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    renameGroup(g.id);
                                                }}
                                                className="px-1 text-slate-500 hover:text-slate-800"
                                            >
                                                ✎
                                            </button>
                                            <button
                                                type="button"
                                                title="Delete"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    deleteGroup(g.id);
                                                }}
                                                className="px-1 text-rose-500 hover:text-rose-700"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </aside>

                {/* Monitor list for active group */}
                <section className="border border-slate-200 rounded-lg bg-white">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Monitors {activeGroupId ? `in ${sortedGroups.find((g) => g.id === activeGroupId)?.name}` : ""}
                        </span>
                        <button
                            type="button"
                            onClick={addMonitor}
                            disabled={!activeGroupId}
                            className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                        >
                            + Add monitor
                        </button>
                    </div>
                    <div className="divide-y divide-slate-100">
                        {activeMonitors.length === 0 && (
                            <div className="px-3 py-6 text-sm text-slate-500 text-center">
                                {activeGroupId ? "No monitors in this group." : "Select or create a group."}
                            </div>
                        )}
                        {activeMonitors.map((m) => (
                            <MonitorRow
                                key={m.id}
                                monitor={m}
                                groups={sortedGroups}
                                onChange={(patch) => updateMonitor(m.id, patch)}
                                onDelete={() => deleteMonitor(m.id)}
                            />
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
}

interface RowProps {
    monitor: MonitorTarget;
    groups: MonitorGroup[];
    onChange: (patch: Partial<MonitorTarget>) => void;
    onDelete: () => void;
}

function MonitorRow({ monitor, groups, onChange, onDelete }: RowProps) {
    const [expanded, setExpanded] = useState(false);
    const auth = monitor.auth ?? { kind: "none" as const };
    return (
        <div className="px-3 py-3 space-y-2">
            <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none">
                    <input
                        type="checkbox"
                        checked={monitor.enabled !== false}
                        onChange={(e) => onChange({ enabled: e.target.checked })}
                        className="rounded"
                    />
                    Enabled
                </label>
                <input
                    type="text"
                    value={monitor.label}
                    onChange={(e) => onChange({ label: e.target.value })}
                    placeholder="Label"
                    className="text-sm border border-slate-300 rounded px-2 py-1 w-48"
                />
                <input
                    type="text"
                    value={monitor.url}
                    onChange={(e) => onChange({ url: e.target.value })}
                    placeholder="https://host/path"
                    className="text-sm border border-slate-300 rounded px-2 py-1 flex-1 font-mono"
                />
                <button
                    type="button"
                    onClick={() => setExpanded((x) => !x)}
                    className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
                >
                    {expanded ? "▴ less" : "▾ more"}
                </button>
                <button
                    type="button"
                    onClick={onDelete}
                    className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-600 hover:bg-rose-50"
                >
                    Delete
                </button>
            </div>
            {expanded && (
                <div className="grid grid-cols-2 gap-2 pl-1 pt-1">
                    <Labeled label="Group">
                        <select
                            value={monitor.groupId}
                            onChange={(e) => onChange({ groupId: e.target.value })}
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full"
                        >
                            {groups.map((g) => (
                                <option key={g.id} value={g.id}>
                                    {g.name}
                                </option>
                            ))}
                        </select>
                    </Labeled>
                    <Labeled label="Method">
                        <select
                            value={monitor.method ?? "GET"}
                            onChange={(e) => onChange({ method: e.target.value as "GET" | "HEAD" })}
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full"
                        >
                            <option value="GET">GET</option>
                            <option value="HEAD">HEAD</option>
                        </select>
                    </Labeled>
                    <Labeled label="Timeout (ms)">
                        <input
                            type="number"
                            min={500}
                            max={60000}
                            step={500}
                            value={monitor.timeoutMs ?? 5000}
                            onChange={(e) => onChange({ timeoutMs: Number(e.target.value) })}
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full"
                        />
                    </Labeled>
                    <Labeled label="Insecure TLS">
                        <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none">
                            <input
                                type="checkbox"
                                checked={monitor.insecureTls ?? false}
                                onChange={(e) => onChange({ insecureTls: e.target.checked })}
                                className="rounded"
                            />
                            Skip certificate validation
                        </label>
                    </Labeled>
                    <Labeled label="Auth">
                        <select
                            value={auth.kind}
                            onChange={(e) => {
                                const kind = e.target.value as MonitorAuthKind;
                                onChange({ auth: { ...auth, kind } });
                            }}
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full"
                        >
                            {AUTH_KINDS.map((k) => (
                                <option key={k} value={k}>
                                    {k}
                                </option>
                            ))}
                        </select>
                    </Labeled>
                    {auth.kind === "basic" && (
                        <Labeled label="User : Pass">
                            <div className="flex gap-1">
                                <input
                                    type="text"
                                    placeholder="username"
                                    value={auth.username ?? ""}
                                    onChange={(e) => onChange({ auth: { ...auth, username: e.target.value } })}
                                    className="text-sm border border-slate-300 rounded px-2 py-1 w-1/2"
                                />
                                <input
                                    type="password"
                                    placeholder="password"
                                    value={auth.password ?? ""}
                                    onChange={(e) => onChange({ auth: { ...auth, password: e.target.value } })}
                                    className="text-sm border border-slate-300 rounded px-2 py-1 w-1/2"
                                />
                            </div>
                        </Labeled>
                    )}
                    {auth.kind === "bearer" && (
                        <Labeled label="Bearer token">
                            <input
                                type="password"
                                value={auth.token ?? ""}
                                onChange={(e) => onChange({ auth: { ...auth, token: e.target.value } })}
                                className="text-sm border border-slate-300 rounded px-2 py-1 w-full font-mono"
                            />
                        </Labeled>
                    )}
                    <Labeled label="Expect JSON paths" hint="comma-separated, e.g. status, state, health.status">
                        <input
                            type="text"
                            value={(monitor.expect?.jsonPaths ?? []).join(", ")}
                            onChange={(e) => {
                                const paths = e.target.value
                                    .split(",")
                                    .map((p) => p.trim())
                                    .filter(Boolean);
                                onChange({
                                    expect: { ...(monitor.expect ?? {}), jsonPaths: paths.length ? paths : undefined },
                                });
                            }}
                            placeholder="(auto)"
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full"
                        />
                    </Labeled>
                    <Labeled label="Body must contain" hint="pipe-separated substrings, e.g. <html|Sign in">
                        <input
                            type="text"
                            value={(monitor.expect?.bodyContains ?? []).join(" | ")}
                            onChange={(e) => {
                                const parts = e.target.value
                                    .split("|")
                                    .map((p) => p.trim())
                                    .filter(Boolean);
                                onChange({
                                    expect: { ...(monitor.expect ?? {}), bodyContains: parts.length ? parts : undefined },
                                });
                            }}
                            placeholder="(none)"
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full font-mono"
                        />
                    </Labeled>
                    <Labeled label="Healthy regex" hint="default: ^(UP|OK|HEALTHY|READY|ALIVE|PASS|TRUE)$">
                        <input
                            type="text"
                            value={monitor.expect?.valueRegex ?? ""}
                            onChange={(e) => {
                                const v = e.target.value;
                                onChange({
                                    expect: { ...(monitor.expect ?? {}), valueRegex: v || undefined },
                                });
                            }}
                            placeholder="(default)"
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full font-mono"
                        />
                    </Labeled>
                    <Labeled label="Extra headers" hint="JSON object, e.g. {&quot;X-Foo&quot;:&quot;bar&quot;}">
                        <input
                            type="text"
                            value={monitor.headers ? JSON.stringify(monitor.headers) : ""}
                            onChange={(e) => {
                                const txt = e.target.value.trim();
                                if (!txt) {
                                    onChange({ headers: undefined });
                                    return;
                                }
                                try {
                                    const parsed = JSON.parse(txt) as Record<string, string>;
                                    onChange({ headers: parsed });
                                } catch {
                                    // ignore until valid
                                }
                            }}
                            placeholder='{"X-Foo":"bar"}'
                            className="text-sm border border-slate-300 rounded px-2 py-1 w-full font-mono"
                        />
                    </Labeled>
                </div>
            )}
        </div>
    );
}

function Labeled({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <label className="text-xs text-slate-600 flex flex-col gap-1">
            <span>
                {label}
                {hint && <span className="text-slate-400 font-normal"> · {hint}</span>}
            </span>
            {children}
        </label>
    );
}

function makeId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return `m_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}
