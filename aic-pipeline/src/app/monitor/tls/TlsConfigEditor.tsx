"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import type { TlsMonitorsFile, TlsTarget } from "@/lib/monitors/tls-types";

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
                label: "New target",
                url: "https://example.com",
                warnDays: 30,
                criticalDays: 7,
                enabled: true,
            },
        ]);
    };

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
            await onSave({ targets });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

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
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
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
