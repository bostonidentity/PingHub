"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import type { TlsGroup, TlsMonitorsFile, TlsTarget } from "@/lib/monitors/tls-types";

interface Props {
    initial: TlsMonitorsFile;
    onCancel: () => void;
    onSave: (next: TlsMonitorsFile) => Promise<void>;
}

function makeId(label: string, existing: Set<string>): string {
    const base =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "target";
    let id = base;
    let n = 1;
    while (existing.has(id)) {
        id = `${base}-${n++}`;
    }
    return id;
}

export function TlsConfigEditor({ initial, onCancel, onSave }: Props) {
    const [groups, setGroups] = useState<TlsGroup[]>(() =>
        [...initial.groups].sort((a, b) => a.order - b.order).map((g) => ({ ...g })),
    );
    const [targets, setTargets] = useState<TlsTarget[]>(() =>
        initial.targets.map((t) => ({ ...t })),
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const update = (id: string, patch: Partial<TlsTarget>) => {
        setTargets((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    };

    const remove = (id: string) => {
        setTargets((prev) => prev.filter((t) => t.id !== id));
    };

    const add = () => {
        const existing = new Set(targets.map((t) => t.id));
        const id = makeId("new-target", existing);
        setTargets((prev) => [
            ...prev,
            {
                id,
                groupId: groups[0]?.id,
                label: "New target",
                url: "https://example.com",
                warnDays: 30,
                criticalDays: 7,
                enabled: true,
            },
        ]);
    };

    function addGroup() {
        const name = window.prompt("Group name (e.g. SSO, IG, Federation):");
        if (!name) return;
        const existing = new Set(groups.map((g) => g.id));
        const id = makeId(name, existing);
        setGroups((prev) => [...prev, { id, name, order: prev.length }]);
    }

    function renameGroup(id: string) {
        const g = groups.find((x) => x.id === id);
        if (!g) return;
        const name = window.prompt("New group name:", g.name);
        if (!name) return;
        setGroups((prev) => prev.map((x) => (x.id === id ? { ...x, name } : x)));
    }

    function deleteGroup(id: string) {
        const inUse = targets.some((t) => t.groupId === id);
        if (inUse) {
            const ok = window.confirm(
                "Group has targets. Delete the group? Targets will be moved to Ungrouped.",
            );
            if (!ok) return;
            setTargets((prev) =>
                prev.map((t) => (t.groupId === id ? { ...t, groupId: undefined } : t)),
            );
        }
        setGroups((prev) => prev.filter((g) => g.id !== id));
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

    const handleSave = async () => {
        setError(null);
        for (const t of targets) {
            if (!t.label.trim()) {
                setError("Every target needs a label.");
                return;
            }
            try {
                new URL(t.url.includes("://") ? t.url : `https://${t.url}`);
            } catch {
                setError(`Invalid URL: ${t.url}`);
                return;
            }
            if ((t.warnDays ?? 30) < (t.criticalDays ?? 7)) {
                setError(`${t.label}: warn days must be ≥ critical days.`);
                return;
            }
        }
        setSaving(true);
        try {
            await onSave({ groups, targets });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    const sortedGroups = [...groups].sort((a, b) => a.order - b.order);

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-900">TLS targets</h2>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={add}
                    className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                    + Add target
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300"
                >
                    {saving ? "Saving…" : "Save"}
                </button>
            </div>

            {error && (
                <div className="text-rose-600 text-sm bg-rose-50 border border-rose-200 rounded px-3 py-2">
                    {error}
                </div>
            )}

            {/* Groups manager */}
            <div className="border border-slate-200 rounded-lg bg-white px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Groups
                    </span>
                    {sortedGroups.length === 0 && (
                        <span className="text-xs text-slate-500">
                            No groups yet — targets will appear as Ungrouped.
                        </span>
                    )}
                    {sortedGroups.map((g, idx) => {
                        const count = targets.filter((t) => t.groupId === g.id).length;
                        return (
                            <span
                                key={g.id}
                                className="inline-flex items-center gap-1 bg-slate-100 border border-slate-200 rounded-full pl-2 pr-1 py-0.5 text-xs"
                            >
                                <span className="text-slate-700">{g.name}</span>
                                <span className="text-slate-400">({count})</span>
                                <button
                                    type="button"
                                    title="Move up"
                                    onClick={() => moveGroup(g.id, -1)}
                                    disabled={idx === 0}
                                    className="px-1 text-slate-500 hover:text-slate-800 disabled:opacity-30"
                                >
                                    ↑
                                </button>
                                <button
                                    type="button"
                                    title="Move down"
                                    onClick={() => moveGroup(g.id, 1)}
                                    disabled={idx === sortedGroups.length - 1}
                                    className="px-1 text-slate-500 hover:text-slate-800 disabled:opacity-30"
                                >
                                    ↓
                                </button>
                                <button
                                    type="button"
                                    title="Rename"
                                    onClick={() => renameGroup(g.id)}
                                    className="px-1 text-slate-500 hover:text-slate-800"
                                >
                                    ✎
                                </button>
                                <button
                                    type="button"
                                    title="Delete"
                                    onClick={() => deleteGroup(g.id)}
                                    className="px-1 text-rose-500 hover:text-rose-700"
                                >
                                    ×
                                </button>
                            </span>
                        );
                    })}
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={addGroup}
                        className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100"
                    >
                        + Add group
                    </button>
                </div>
            </div>

            {targets.length === 0 && (
                <div className="text-slate-500 text-sm border border-dashed border-slate-300 rounded-lg px-4 py-8 text-center">
                    No targets yet. Click <span className="font-medium">+ Add target</span> to start.
                </div>
            )}

            <div className="space-y-2">
                {targets.map((t) => (
                    <div
                        key={t.id}
                        className={cn(
                            "border border-slate-200 rounded-lg p-3 bg-white",
                            t.enabled === false && "opacity-60",
                        )}
                    >
                        <div className="flex items-center gap-2 mb-2">
                            <label className="flex items-center gap-1 text-xs text-slate-600">
                                <input
                                    type="checkbox"
                                    checked={t.enabled !== false}
                                    onChange={(e) => update(t.id, { enabled: e.target.checked })}
                                />
                                Enabled
                            </label>
                            <input
                                type="text"
                                value={t.label}
                                onChange={(e) => update(t.id, { label: e.target.value })}
                                placeholder="Label"
                                className="text-sm border border-slate-300 rounded px-2 py-1 flex-1 min-w-[160px]"
                            />
                            <input
                                type="text"
                                value={t.url}
                                onChange={(e) => update(t.id, { url: e.target.value })}
                                placeholder="https://host.example.com or host:port"
                                className="text-sm border border-slate-300 rounded px-2 py-1 flex-[2] min-w-[260px] font-mono"
                            />
                            <button
                                type="button"
                                onClick={() => remove(t.id)}
                                className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50"
                            >
                                Remove
                            </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                            <Labeled label="Group">
                                <select
                                    value={t.groupId ?? ""}
                                    onChange={(e) =>
                                        update(t.id, { groupId: e.target.value || undefined })
                                    }
                                    className="text-sm border border-slate-300 rounded px-2 py-1 w-full bg-white"
                                >
                                    <option value="">— Ungrouped —</option>
                                    {sortedGroups.map((g) => (
                                        <option key={g.id} value={g.id}>
                                            {g.name}
                                        </option>
                                    ))}
                                </select>
                            </Labeled>
                            <Labeled label="Warn at (days)">
                                <input
                                    type="number"
                                    min={1}
                                    value={t.warnDays ?? 30}
                                    onChange={(e) =>
                                        update(t.id, { warnDays: Number(e.target.value) || 30 })
                                    }
                                    className="text-sm border border-slate-300 rounded px-2 py-1 w-full"
                                />
                            </Labeled>
                            <Labeled label="Critical at (days)">
                                <input
                                    type="number"
                                    min={0}
                                    value={t.criticalDays ?? 7}
                                    onChange={(e) =>
                                        update(t.id, { criticalDays: Number(e.target.value) || 0 })
                                    }
                                    className="text-sm border border-slate-300 rounded px-2 py-1 w-full"
                                />
                            </Labeled>
                            <Labeled label="SNI servername (optional)">
                                <input
                                    type="text"
                                    value={t.servername ?? ""}
                                    onChange={(e) =>
                                        update(t.id, { servername: e.target.value || undefined })
                                    }
                                    placeholder="defaults to URL hostname"
                                    className="text-sm border border-slate-300 rounded px-2 py-1 w-full font-mono"
                                />
                            </Labeled>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <div className="text-xs text-slate-500 mb-0.5">{label}</div>
            {children}
        </label>
    );
}
