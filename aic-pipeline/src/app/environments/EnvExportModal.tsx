"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Environment } from "@/lib/fr-config-types";

type SecretsMode = "exclude" | "plain" | "encrypted";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    environments: Environment[];
}

export function EnvExportModal({ open, onOpenChange, environments }: Props) {
    const [selected, setSelected] = useState<Set<string>>(new Set(environments.map((e) => e.name)));
    const [mode, setMode] = useState<SecretsMode>("exclude");
    const [passphrase, setPassphrase] = useState("");
    const [confirmPassphrase, setConfirmPassphrase] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    // Re-seed selection whenever the modal opens
    function handleOpenChange(o: boolean) {
        if (o) {
            setSelected(new Set(environments.map((e) => e.name)));
            setMode("exclude");
            setPassphrase("");
            setConfirmPassphrase("");
            setErr(null);
        }
        onOpenChange(o);
    }

    function toggle(name: string) {
        const next = new Set(selected);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        setSelected(next);
    }

    async function doExport() {
        setErr(null);
        if (selected.size === 0) {
            setErr("select at least one environment");
            return;
        }
        if (mode === "encrypted") {
            if (passphrase.length < 12) return setErr("passphrase must be at least 12 characters");
            if (passphrase !== confirmPassphrase) return setErr("passphrases do not match");
        }
        setBusy(true);
        try {
            const res = await fetch("/api/environments/export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    names: [...selected],
                    secretsMode: mode,
                    passphrase: mode === "encrypted" ? passphrase : undefined,
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `export failed (${res.status})`);
            }
            const cd = res.headers.get("Content-Disposition") || "";
            const m = /filename="([^"]+)"/.exec(cd);
            const filename = m?.[1] ?? `pinghub-envs-${Date.now()}.json`;
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            onOpenChange(false);
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
                <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(560px,calc(100vw-32px))] max-h-[calc(100vh-48px)] overflow-y-auto bg-white rounded-2xl shadow-2xl">
                    <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                        <Dialog.Title className="text-base font-semibold text-slate-900">Export environments</Dialog.Title>
                        <Dialog.Close asChild>
                            <button aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1 rounded">
                                <X size={18} />
                            </button>
                        </Dialog.Close>
                    </div>

                    <div className="px-5 py-4 space-y-5">
                        <section>
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-sm font-medium text-slate-700">Environments ({selected.size}/{environments.length})</h3>
                                <div className="flex gap-2 text-xs">
                                    <button
                                        type="button"
                                        className="text-indigo-600 hover:underline"
                                        onClick={() => setSelected(new Set(environments.map((e) => e.name)))}
                                    >Select all</button>
                                    <button
                                        type="button"
                                        className="text-slate-500 hover:underline"
                                        onClick={() => setSelected(new Set())}
                                    >Clear</button>
                                </div>
                            </div>
                            <div className="border rounded max-h-44 overflow-auto divide-y">
                                {environments.map((env) => (
                                    <label key={env.name} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-slate-50">
                                        <input
                                            type="checkbox"
                                            checked={selected.has(env.name)}
                                            onChange={() => toggle(env.name)}
                                        />
                                        <span className="font-medium">{env.label}</span>
                                        <span className="text-xs font-mono text-slate-500">{env.name}</span>
                                        <span className={cn("ml-auto text-[10px] px-1.5 py-0.5 rounded ring-1", env.type === "controlled" ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-slate-50 text-slate-600 ring-slate-200")}>
                                            {env.type}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </section>

                        <section className="space-y-2">
                            <h3 className="text-sm font-medium text-slate-700">Secrets</h3>
                            <RadioRow
                                label="Exclude (recommended for sharing)"
                                hint="SERVICE_ACCOUNT_KEY and similar are replaced with <REDACTED>"
                                checked={mode === "exclude"}
                                onChange={() => setMode("exclude")}
                            />
                            <RadioRow
                                label="Include plaintext"
                                hint="Bundle file contains real secret values. Treat as sensitive."
                                tone="warn"
                                checked={mode === "plain"}
                                onChange={() => setMode("plain")}
                            />
                            <RadioRow
                                label="Include encrypted (AES-256-GCM, passphrase)"
                                hint="Same passphrase needed to import. No recovery if lost."
                                checked={mode === "encrypted"}
                                onChange={() => setMode("encrypted")}
                            />
                            {mode === "encrypted" && (
                                <div className="grid grid-cols-1 gap-2 pl-6 mt-1">
                                    <input
                                        type="password"
                                        autoComplete="new-password"
                                        placeholder="Passphrase (≥ 12 chars)"
                                        value={passphrase}
                                        onChange={(e) => setPassphrase(e.target.value)}
                                        className="border rounded px-2 py-1 text-sm"
                                    />
                                    <input
                                        type="password"
                                        autoComplete="new-password"
                                        placeholder="Confirm passphrase"
                                        value={confirmPassphrase}
                                        onChange={(e) => setConfirmPassphrase(e.target.value)}
                                        className="border rounded px-2 py-1 text-sm"
                                    />
                                </div>
                            )}
                        </section>

                        {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{err}</div>}
                    </div>

                    <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50/50 rounded-b-2xl">
                        <Dialog.Close asChild>
                            <button className="btn-secondary">Cancel</button>
                        </Dialog.Close>
                        <button
                            onClick={doExport}
                            disabled={busy || selected.size === 0}
                            className="btn-primary"
                        >
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                            Download bundle
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function RadioRow({
    label,
    hint,
    checked,
    onChange,
    tone,
}: {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: () => void;
    tone?: "warn";
}) {
    return (
        <label className={cn(
            "flex items-start gap-2 px-3 py-2 border rounded cursor-pointer text-sm",
            checked ? "border-indigo-300 bg-indigo-50/50" : "border-slate-200 hover:bg-slate-50",
        )}>
            <input type="radio" className="mt-0.5" checked={checked} onChange={onChange} />
            <div className="flex-1">
                <div className={cn("font-medium", tone === "warn" && "text-amber-800")}>{label}</div>
                {hint && <div className="text-xs text-slate-500 mt-0.5">{hint}</div>}
            </div>
        </label>
    );
}
