"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Trash2, Download, RotateCcw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface BackupFile {
    filename: string;
    envName: string;
    timestamp: string;
    size: number;
    mtime: string;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged?: () => void;
}

export function EnvBackupsModal({ open, onOpenChange, onChanged }: Props) {
    const [backups, setBackups] = useState<BackupFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    async function load() {
        setLoading(true);
        setErr(null);
        try {
            const res = await fetch("/api/environments/backups");
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
            setBackups(body.backups as BackupFile[]);
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (open) load();
    }, [open]);

    async function handleDelete(file: string) {
        if (!confirm(`Delete backup ${file}?`)) return;
        const res = await fetch(`/api/environments/backups?file=${encodeURIComponent(file)}`, {
            method: "DELETE",
        });
        if (res.ok) {
            load();
            onChanged?.();
        } else {
            const b = await res.json().catch(() => ({}));
            alert(b.error || "delete failed");
        }
    }

    async function handleDownload(file: string) {
        const res = await fetch(`/api/environments/backups?file=${encodeURIComponent(file)}`);
        if (!res.ok) {
            alert("download failed");
            return;
        }
        const text = await res.text();
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    async function handlePrune() {
        if (!confirm("Prune backups older than 7 days, keeping the 10 newest per environment?")) return;
        // Run prune per unique env
        const envNames = [...new Set(backups.map((b) => b.envName))];
        for (const n of envNames) {
            await fetch(`/api/environments/backups?prune=${encodeURIComponent(n)}`, { method: "DELETE" });
        }
        load();
        onChanged?.();
    }

    // Group by env name for display
    const grouped = backups.reduce<Record<string, BackupFile[]>>((acc, b) => {
        (acc[b.envName] ??= []).push(b);
        return acc;
    }, {});

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=open]:fade-in" />
                <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(720px,calc(100vw-32px))] max-h-[calc(100vh-48px)] overflow-y-auto bg-white rounded-2xl shadow-2xl">
                    <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                        <Dialog.Title className="text-base font-semibold text-slate-900">Environment backups</Dialog.Title>
                        <Dialog.Close asChild>
                            <button aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1 rounded">
                                <X size={18} />
                            </button>
                        </Dialog.Close>
                    </div>

                    <div className="px-5 py-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-slate-500">
                                Stored under <code className="font-mono">environments/.backups/</code>. Created automatically before any
                                import overwrite.
                            </p>
                            <div className="flex gap-2">
                                <button
                                    onClick={load}
                                    className="btn-secondary text-xs px-3 py-1.5"
                                    disabled={loading}
                                >
                                    {loading ? <Loader2 size={11} className="animate-spin" /> : null}
                                    Refresh
                                </button>
                                <button
                                    onClick={handlePrune}
                                    className="btn-danger-outline text-xs px-3 py-1.5 disabled:opacity-50"
                                    disabled={loading || backups.length === 0}
                                >
                                    Prune old
                                </button>
                            </div>
                        </div>

                        {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}

                        {!loading && backups.length === 0 && (
                            <div className="text-sm text-slate-400 text-center py-8 border border-dashed rounded">
                                No backups yet
                            </div>
                        )}

                        {Object.entries(grouped).map(([env, files]) => (
                            <div key={env} className="border rounded">
                                <div className="px-3 py-1.5 bg-slate-50 border-b text-sm font-medium font-mono">
                                    {env}
                                    <span className="ml-2 text-xs text-slate-500 font-sans">({files.length})</span>
                                </div>
                                <table className="w-full text-sm">
                                    <tbody className="divide-y">
                                        {files.map((f) => (
                                            <tr key={f.filename}>
                                                <td className="px-3 py-1.5 font-mono text-xs">{f.timestamp}</td>
                                                <td className="px-3 py-1.5 text-xs text-slate-500">{formatBytes(f.size)}</td>
                                                <td className="px-3 py-1.5 text-right">
                                                    <div className="inline-flex items-center gap-1">
                                                        <button
                                                            title="Download"
                                                            onClick={() => handleDownload(f.filename)}
                                                            className="p-1 text-slate-500 hover:text-slate-800"
                                                        >
                                                            <Download size={13} />
                                                        </button>
                                                        <button
                                                            title="Restore — reopen Import dialog with this file (download then re-upload)"
                                                            disabled
                                                            className={cn("p-1 text-slate-300 cursor-not-allowed")}
                                                        >
                                                            <RotateCcw size={13} />
                                                        </button>
                                                        <button
                                                            title="Delete"
                                                            onClick={() => handleDelete(f.filename)}
                                                            className="p-1 text-rose-500 hover:text-rose-700"
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ))}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
