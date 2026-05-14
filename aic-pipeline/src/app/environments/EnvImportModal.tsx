"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Upload, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Environment } from "@/lib/fr-config-types";

type ImportAction = "skip" | "overwrite" | "rename";

interface BundleEntry {
    meta: Environment;
    envVars: Record<string, unknown>;
}

interface ParsedBundle {
    $schema: string;
    exportedAt?: string;
    exportedBy?: string;
    appVersion?: string;
    secretsIncluded: boolean;
    secretsEncryption: "none" | "passphrase-aes-256-gcm";
    environments: BundleEntry[];
}

interface ImportResult {
    bundleName: string;
    finalName: string;
    action: ImportAction;
    status: "applied" | "skipped" | "failed";
    error?: string;
    backupPath?: string | null;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    liveEnvironments: Environment[];
    onImported?: () => void;
}

interface RowState {
    action: ImportAction;
    renameTo: string;
    preserveLiveSecrets: boolean;
}

export function EnvImportModal({ open, onOpenChange, liveEnvironments, onImported }: Props) {
    const [bundle, setBundle] = useState<ParsedBundle | null>(null);
    const [filename, setFilename] = useState<string>("");
    const [rowState, setRowState] = useState<Record<string, RowState>>({});
    const [passphrase, setPassphrase] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [results, setResults] = useState<ImportResult[] | null>(null);

    function reset() {
        setBundle(null);
        setFilename("");
        setRowState({});
        setPassphrase("");
        setErr(null);
        setResults(null);
    }

    function handleOpenChange(o: boolean) {
        if (o) reset();
        onOpenChange(o);
    }

    const liveNames = new Set(liveEnvironments.map((e) => e.name));

    async function onFile(f: File) {
        setErr(null);
        setResults(null);
        try {
            const text = await f.text();
            const parsed = JSON.parse(text) as ParsedBundle;
            if (parsed.$schema !== "pinghub-environments/v1") {
                throw new Error(`unsupported schema: ${parsed.$schema}`);
            }
            const initial: Record<string, RowState> = {};
            for (const e of parsed.environments) {
                initial[e.meta.name] = {
                    action: liveNames.has(e.meta.name) ? "overwrite" : "overwrite",
                    renameTo: `${e.meta.name}-imported`,
                    preserveLiveSecrets: true,
                };
            }
            setRowState(initial);
            setBundle(parsed);
            setFilename(f.name);
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        }
    }

    function setRow(name: string, patch: Partial<RowState>) {
        setRowState({ ...rowState, [name]: { ...rowState[name], ...patch } });
    }

    async function doImport() {
        if (!bundle) return;
        setErr(null);
        setBusy(true);
        setResults(null);
        try {
            const decisions = bundle.environments.map((e) => ({
                name: e.meta.name,
                action: rowState[e.meta.name]?.action ?? "skip",
                renameTo: rowState[e.meta.name]?.renameTo,
                preserveLiveSecrets: rowState[e.meta.name]?.preserveLiveSecrets ?? true,
            }));
            const res = await fetch("/api/environments/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    bundle,
                    decisions,
                    passphrase: bundle.secretsEncryption === "passphrase-aes-256-gcm" ? passphrase : undefined,
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `import failed (${res.status})`);
            setResults(body.results as ImportResult[]);
            onImported?.();
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog.Root open={open} onOpenChange={handleOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=open]:fade-in" />
                <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(720px,calc(100vw-32px))] max-h-[calc(100vh-48px)] overflow-y-auto bg-white rounded-2xl shadow-2xl">
                    <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                        <Dialog.Title className="text-base font-semibold text-slate-900">Import environments</Dialog.Title>
                        <Dialog.Close asChild>
                            <button aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1 rounded">
                                <X size={18} />
                            </button>
                        </Dialog.Close>
                    </div>

                    <div className="px-5 py-4 space-y-4">
                        {!bundle && (
                            <div>
                                <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30">
                                    <Upload size={28} className="text-slate-400" />
                                    <span className="text-sm text-slate-600">Click to choose a bundle JSON file</span>
                                    <input
                                        type="file"
                                        accept="application/json,.json"
                                        className="hidden"
                                        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
                                    />
                                </label>
                                {err && <div className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}
                            </div>
                        )}

                        {bundle && !results && (
                            <>
                                <div className="flex items-baseline justify-between">
                                    <div>
                                        <div className="text-sm font-medium">{filename}</div>
                                        <div className="text-xs text-slate-500">
                                            {bundle.environments.length} env(s)
                                            {" · "}secrets:{" "}
                                            <span className={cn(bundle.secretsIncluded ? "text-amber-700 font-medium" : "text-slate-600")}>
                                                {bundle.secretsIncluded
                                                    ? bundle.secretsEncryption === "passphrase-aes-256-gcm"
                                                        ? "encrypted"
                                                        : "plaintext"
                                                    : "redacted"}
                                            </span>
                                            {bundle.exportedAt && <> · exported {new Date(bundle.exportedAt).toLocaleString()}</>}
                                            {bundle.appVersion && <> · v{bundle.appVersion}</>}
                                        </div>
                                    </div>
                                    <button onClick={reset} className="text-xs text-slate-500 hover:underline">Choose different file</button>
                                </div>

                                {bundle.secretsEncryption === "passphrase-aes-256-gcm" && (
                                    <div>
                                        <label className="text-xs font-medium text-slate-600">Passphrase</label>
                                        <input
                                            type="password"
                                            autoComplete="off"
                                            value={passphrase}
                                            onChange={(e) => setPassphrase(e.target.value)}
                                            className="w-full border rounded px-2 py-1 text-sm mt-1"
                                            placeholder="Required to decrypt secrets"
                                        />
                                    </div>
                                )}

                                <div className="border rounded overflow-hidden">
                                    <table className="w-full text-sm">
                                        <thead className="bg-slate-50 text-xs text-slate-600">
                                            <tr>
                                                <th className="text-left px-3 py-2">Bundle name</th>
                                                <th className="text-left px-3 py-2">Status</th>
                                                <th className="text-left px-3 py-2">Action</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {bundle.environments.map((e) => {
                                                const exists = liveNames.has(e.meta.name);
                                                const row = rowState[e.meta.name];
                                                return (
                                                    <tr key={e.meta.name}>
                                                        <td className="px-3 py-2">
                                                            <div className="font-medium">{e.meta.label || e.meta.name}</div>
                                                            <div className="text-[11px] font-mono text-slate-500">{e.meta.name}</div>
                                                        </td>
                                                        <td className="px-3 py-2">
                                                            <span className={cn(
                                                                "inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full ring-1",
                                                                exists ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200",
                                                            )}>
                                                                {exists ? "exists" : "new"}
                                                            </span>
                                                        </td>
                                                        <td className="px-3 py-2">
                                                            <div className="flex items-center gap-2">
                                                                <select
                                                                    value={row?.action ?? "skip"}
                                                                    onChange={(ev) => setRow(e.meta.name, { action: ev.target.value as ImportAction })}
                                                                    className="border rounded px-1.5 py-1 text-xs"
                                                                >
                                                                    <option value="skip">Skip</option>
                                                                    <option value="overwrite">{exists ? "Replace (auto-backup)" : "Create"}</option>
                                                                    <option value="rename">Rename</option>
                                                                </select>
                                                                {row?.action === "rename" && (
                                                                    <input
                                                                        type="text"
                                                                        value={row.renameTo}
                                                                        onChange={(ev) => setRow(e.meta.name, { renameTo: ev.target.value })}
                                                                        className="border rounded px-1.5 py-1 text-xs font-mono w-32"
                                                                    />
                                                                )}
                                                            </div>
                                                            {exists && row?.action === "overwrite" && (
                                                                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                                                                    <AlertTriangle size={11} />
                                                                    Auto-backup before replacing
                                                                </div>
                                                            )}
                                                            {exists && !bundle.secretsIncluded && row?.action === "overwrite" && (
                                                                <label className="flex items-center gap-1.5 text-[11px] text-slate-600 mt-1 cursor-pointer">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={row.preserveLiveSecrets}
                                                                        onChange={(ev) => setRow(e.meta.name, { preserveLiveSecrets: ev.target.checked })}
                                                                    />
                                                                    Keep live secrets where bundle is redacted
                                                                </label>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>

                                {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}
                            </>
                        )}

                        {results && (
                            <div className="space-y-2">
                                <div className="text-sm font-medium">Import results</div>
                                <div className="border rounded overflow-hidden">
                                    <table className="w-full text-sm">
                                        <thead className="bg-slate-50 text-xs text-slate-600">
                                            <tr>
                                                <th className="text-left px-3 py-2">Env</th>
                                                <th className="text-left px-3 py-2">Status</th>
                                                <th className="text-left px-3 py-2">Backup</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {results.map((r) => (
                                                <tr key={r.bundleName}>
                                                    <td className="px-3 py-2 font-mono text-xs">
                                                        {r.bundleName}
                                                        {r.bundleName !== r.finalName && <> → {r.finalName}</>}
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        <span className={cn(
                                                            "inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full ring-1",
                                                            r.status === "applied" && "bg-emerald-50 text-emerald-700 ring-emerald-200",
                                                            r.status === "skipped" && "bg-slate-50 text-slate-600 ring-slate-200",
                                                            r.status === "failed" && "bg-rose-50 text-rose-700 ring-rose-200",
                                                        )}>
                                                            {r.status}
                                                        </span>
                                                        {r.error && <div className="text-[11px] text-rose-700 mt-1">{r.error}</div>}
                                                    </td>
                                                    <td className="px-3 py-2 text-[11px] font-mono text-slate-500 break-all">
                                                        {r.backupPath ?? "—"}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50/50 rounded-b-2xl">
                        {results ? (
                            <Dialog.Close asChild>
                                <button className="btn-secondary">Close</button>
                            </Dialog.Close>
                        ) : (
                            <>
                                <Dialog.Close asChild>
                                    <button className="btn-secondary">Cancel</button>
                                </Dialog.Close>
                                <button
                                    onClick={doImport}
                                    disabled={!bundle || busy}
                                    className="btn-primary"
                                >
                                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                    Import
                                </button>
                            </>
                        )}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
