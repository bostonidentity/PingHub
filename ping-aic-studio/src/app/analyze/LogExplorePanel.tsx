"use client";

import { useMemo, useState } from "react";
import { DEFAULT_LOG_SOURCES } from "@/lib/logs/log-sources";
import type { ArchiveQueryResult, ArchiveQueryRow } from "@/lib/logs/log-query";

/** Default window: last 24 hours, in datetime-local (local time) format. */
function defaultWindow(): { from: string; to: string } {
    const now = new Date();
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    return { from: fmt(past), to: fmt(now) };
}

const localToIso = (s: string) => new Date(s).toISOString();
const PAGE = 100;
const LEVELS = ["", "INFO", "WARNING", "WARN", "ERROR", "DEBUG"];

function pretty(json: string): string {
    try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; }
}

export function LogExplorePanel({ environments }: { environments: { name: string; label?: string }[] }) {
    const initial = useMemo(defaultWindow, []);
    const [env, setEnv] = useState(environments[0]?.name ?? "");
    const [from, setFrom] = useState(initial.from);
    const [to, setTo] = useState(initial.to);
    const [sources, setSources] = useState<Set<string>>(new Set(DEFAULT_LOG_SOURCES));
    const [eventName, setEventName] = useState("");
    const [transactionId, setTransactionId] = useState("");
    const [userId, setUserId] = useState("");
    const [level, setLevel] = useState("");
    const [text, setText] = useState("");

    const [offset, setOffset] = useState(0);
    const [results, setResults] = useState<ArchiveQueryResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<ArchiveQueryRow | null>(null);

    const toggleSource = (s: string) => setSources((prev) => {
        const next = new Set(prev);
        if (next.has(s)) next.delete(s); else next.add(s);
        return next;
    });

    async function run(nextOffset: number) {
        if (!env || sources.size === 0) {
            setError("Pick an environment and at least one source.");
            return;
        }
        setLoading(true);
        setError(null);
        setSelected(null);
        try {
            const res = await fetch("/api/logs/archive/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    env,
                    from: localToIso(from),
                    to: localToIso(to),
                    sources: [...sources],
                    eventName: eventName.trim() || undefined,
                    transactionId: transactionId.trim() || undefined,
                    userId: userId.trim() || undefined,
                    level: level || undefined,
                    text: text.trim() || undefined,
                    offset: nextOffset,
                    limit: PAGE,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
            setResults(data as ArchiveQueryResult);
            setOffset(nextOffset);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }

    const page = Math.floor(offset / PAGE) + 1;
    const totalPages = results ? Math.max(1, Math.ceil(results.total / PAGE)) : 1;
    const inputCls = "rounded border border-slate-300 px-2 py-1.5 bg-white text-sm";

    return (
        <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Environment</span>
                        <select value={env} onChange={(e) => setEnv(e.target.value)} className={inputCls}>
                            {environments.map((e) => <option key={e.name} value={e.name}>{e.label ?? e.name}</option>)}
                        </select>
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">From</span>
                        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">To</span>
                        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Level</span>
                        <select value={level} onChange={(e) => setLevel(e.target.value)} className={inputCls}>
                            {LEVELS.map((l) => <option key={l || "any"} value={l}>{l || "Any"}</option>)}
                        </select>
                    </label>
                    <button
                        type="button"
                        onClick={() => run(0)}
                        disabled={loading}
                        className="ml-auto rounded bg-sky-600 px-4 py-1.5 text-white text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
                    >
                        {loading ? "Searching…" : "Search"}
                    </button>
                </div>

                <div className="flex flex-wrap gap-3">
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Event name</span>
                        <input value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="exact eventName" className={inputCls} />
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Transaction ID</span>
                        <input value={transactionId} onChange={(e) => setTransactionId(e.target.value)} placeholder="exact transactionId" className={inputCls} />
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">User ID</span>
                        <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="exact userId" className={inputCls} />
                    </label>
                    <label className="text-sm flex-1 min-w-[12rem]">
                        <span className="block text-slate-600 mb-1">Free text</span>
                        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="substring across indexed fields" className={`${inputCls} w-full`} />
                    </label>
                </div>

                <div>
                    <div className="text-xs text-slate-500 mb-1">Sources</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                        {DEFAULT_LOG_SOURCES.map((s) => (
                            <label key={s} className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={sources.has(s)} onChange={() => toggleSource(s)} className="accent-sky-600" />
                                <span className="font-mono text-slate-700 truncate">{s}</span>
                            </label>
                        ))}
                    </div>
                </div>

                {error ? <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
            </div>

            {results ? (
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>{results.total.toLocaleString()} match{results.total === 1 ? "" : "es"}{results.capped ? " (capped — refine filters for complete paging)" : ""}</span>
                        <span>page {page} of {totalPages}</span>
                    </div>
                    {results.capped ? (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            Too many matches to page through fully — showing the earliest. Narrow the window or add filters.
                        </div>
                    ) : null}

                    <div className="rounded-md border border-slate-200 bg-white overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 text-slate-600">
                                <tr>
                                    <th className="text-left px-3 py-2 font-medium">Time</th>
                                    <th className="text-left px-3 py-2 font-medium">Source</th>
                                    <th className="text-left px-3 py-2 font-medium">Event</th>
                                    <th className="text-left px-3 py-2 font-medium">Level</th>
                                    <th className="text-left px-3 py-2 font-medium">Transaction</th>
                                    <th className="text-left px-3 py-2 font-medium">User</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results.rows.length === 0 ? (
                                    <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400 italic">No matching entries.</td></tr>
                                ) : results.rows.map((r) => (
                                    <tr
                                        key={`${r.source}:${r.id}`}
                                        onClick={() => setSelected(r)}
                                        className={`border-t border-slate-100 cursor-pointer hover:bg-sky-50 ${selected?.id === r.id && selected?.source === r.source ? "bg-sky-50" : ""}`}
                                    >
                                        <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{new Date(r.timestamp).toLocaleString()}</td>
                                        <td className="px-3 py-1.5 font-mono text-xs">{r.source}</td>
                                        <td className="px-3 py-1.5 text-xs">{r.eventName}</td>
                                        <td className="px-3 py-1.5 text-xs">{r.level}</td>
                                        <td className="px-3 py-1.5 font-mono text-[11px] max-w-[12rem] truncate" title={r.transactionId}>{r.transactionId}</td>
                                        <td className="px-3 py-1.5 font-mono text-[11px] max-w-[12rem] truncate" title={r.userId}>{r.userId}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="flex items-center justify-between">
                        <button
                            type="button"
                            onClick={() => run(Math.max(0, offset - PAGE))}
                            disabled={loading || offset <= 0}
                            className="text-xs px-2 py-1 border border-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
                        >← Prev</button>
                        <span className="text-xs text-slate-500">page {page} of {totalPages}</span>
                        <button
                            type="button"
                            onClick={() => run(offset + PAGE)}
                            disabled={loading || offset + PAGE >= results.total}
                            className="text-xs px-2 py-1 border border-slate-300 rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
                        >Next →</button>
                    </div>

                    {selected ? (
                        <div className="rounded-md border border-slate-200 bg-white">
                            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between">
                                <span className="text-sm font-semibold text-slate-700">
                                    {selected.source} · {selected.eventName} · {new Date(selected.timestamp).toLocaleString()}
                                </span>
                                <button type="button" onClick={() => setSelected(null)} className="text-xs text-slate-400 hover:text-slate-600">✕ close</button>
                            </div>
                            <pre className="p-3 text-[11px] font-mono text-slate-700 overflow-x-auto max-h-96 whitespace-pre-wrap">{pretty(selected.payloadJson)}</pre>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
