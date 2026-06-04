"use client";

import { useMemo, useState } from "react";
import type { JourneyHistoryReport, JourneyAttempt } from "@/lib/reports/journey-history";

/** Default window: last 24 hours, rounded to the second. */
function defaultWindow(): { from: string; to: string } {
    const now = new Date();
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // datetime-local needs `YYYY-MM-DDTHH:mm` in *local* time.
    const fmt = (d: Date) => {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    return { from: fmt(past), to: fmt(now) };
}

/** Convert a datetime-local string (local time) to an ISO UTC string. */
function localToIso(localStr: string): string {
    return new Date(localStr).toISOString();
}

function Stat({ label, value, sub, tone = "slate" }: { label: string; value: number | string; sub?: string; tone?: "slate" | "emerald" | "rose" | "amber" }) {
    const toneClass = {
        slate: "text-slate-900",
        emerald: "text-emerald-700",
        rose: "text-rose-700",
        amber: "text-amber-700",
    }[tone];
    return (
        <div className="rounded-md border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
            <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
            {sub ? <div className="text-xs text-slate-500 mt-0.5">{sub}</div> : null}
        </div>
    );
}

type ScanReport = JourneyHistoryReport & {
    window?: { from: string; to: string };
    env?: string;
    eventsFetched?: number;
    pagesFetched?: number;
    rawFetched?: number;
    topEventNames?: { name: string; count: number }[];
    source?: "live" | "archive";
    coverage?: "full" | "partial" | "none";
};

const num = (n: number) => n.toLocaleString();

function fmtWindowTs(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Always-available breakdown of what AIC returned for this run. */
function ScanDetails({ report, defaultOpen }: { report: ScanReport; defaultOpen: boolean }) {
    const matched = report.eventsFetched ?? report.summary.eventsProcessed;
    const raw = report.rawFetched;
    const dropped = typeof raw === "number" ? Math.max(0, raw - matched) : undefined;
    const isArchive = report.source === "archive";
    const items: { label: string; value: string }[] = [
        ...(report.window ? [{ label: "Window", value: `${fmtWindowTs(report.window.from)} → ${fmtWindowTs(report.window.to)}` }] : []),
        ...(isArchive ? [{ label: "Source", value: "Local archive" }] : [{ label: "Pages fetched", value: num(report.pagesFetched ?? 0) }]),
        ...(typeof raw === "number" ? [{ label: isArchive ? "Records read from archive" : "Raw events from AIC", value: num(raw) }] : []),
        { label: "Journey events kept", value: num(matched) },
        ...(typeof dropped === "number" ? [{ label: "Dropped (non-journey)", value: num(dropped) }] : []),
        { label: "Attempts reconstructed", value: num(report.summary.attempts) },
        { label: "Distinct transactions", value: num(report.summary.transactions) },
        { label: "Status", value: report.truncated ? "TRUNCATED — raise Max events or narrow window" : "Complete" },
    ];
    return (
        <details open={defaultOpen} className="rounded-md border border-slate-200 bg-white text-sm">
            <summary className="cursor-pointer select-none px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
                Scan details
            </summary>
            <div className="space-y-3 px-4 pb-3 pt-1">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 md:grid-cols-3">
                    {items.map((it) => (
                        <div key={it.label} className="flex flex-col">
                            <dt className="text-xs uppercase tracking-wide text-slate-500">{it.label}</dt>
                            <dd className={`font-mono ${report.truncated && it.label === "Status" ? "text-amber-700" : "text-slate-800"}`}>{it.value}</dd>
                        </div>
                    ))}
                </dl>
                {report.topEventNames && report.topEventNames.length > 0 ? (
                    <div>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Event names observed ({report.topEventNames.length})
                        </div>
                        <ul className="font-mono text-[11px] text-slate-700">
                            {report.topEventNames.map((e) => (
                                <li key={e.name}>{num(e.count).padStart(7)}  {e.name}</li>
                            ))}
                        </ul>
                    </div>
                ) : null}
            </div>
        </details>
    );
}

type AttemptFilter = "all" | "fail" | "incomplete";
type ScopeFilter = "outer" | "inner" | "all";

export function JourneyHistoryPanel({ environments }: { environments: { name: string }[] }) {
    const initialWindow = useMemo(defaultWindow, []);
    const [env, setEnv] = useState(environments[0]?.name ?? "");
    const [from, setFrom] = useState(initialWindow.from);
    const [to, setTo] = useState(initialWindow.to);
    const [treeName, setTreeName] = useState("");
    const [scope, setScope] = useState<ScopeFilter>("outer");
    const [maxEvents, setMaxEvents] = useState(20000);
    const [dataSource, setDataSource] = useState<"live" | "archive">("live");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [report, setReport] = useState<ScanReport | null>(null);
    const [attemptFilter, setAttemptFilter] = useState<AttemptFilter>("all");
    const [scanProgress, setScanProgress] = useState<{ page: number; rawFetched: number; matched: number } | null>(null);

    async function run() {
        if (!env || !from || !to) {
            setError("Environment, From, and To are required.");
            return;
        }
        setLoading(true);
        setError(null);
        setReport(null);
        setScanProgress(null);
        try {
            const res = await fetch("/api/analyze/journey-history", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    env,
                    from: localToIso(from),
                    to: localToIso(to),
                    treeName: treeName.trim() || undefined,
                    maxEvents,
                    source: dataSource,
                }),
            });
            // Validation failures come back as a plain JSON error with a non-2xx
            // status; a successful run streams NDJSON progress lines.
            if (!res.ok || !res.body) {
                let msg = `HTTP ${res.status}`;
                try {
                    const d = await res.json();
                    if (d?.error) msg = d.error;
                } catch { /* non-JSON body */ }
                throw new Error(msg);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let finished = false;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    const msg = JSON.parse(line) as
                        | { type: "progress"; page: number; rawFetched: number; matched: number }
                        | ({ type: "done" } & ScanReport)
                        | { type: "error"; error: string };
                    if (msg.type === "progress") {
                        setScanProgress({ page: msg.page, rawFetched: msg.rawFetched, matched: msg.matched });
                    } else if (msg.type === "error") {
                        throw new Error(msg.error);
                    } else if (msg.type === "done") {
                        const { type: _t, ...rep } = msg;
                        void _t;
                        setReport(rep);
                        finished = true;
                    }
                }
            }
            if (!finished) throw new Error("Scan ended without a result.");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
            setScanProgress(null);
        }
    }

    function exportAttemptsCsv() {
        if (!report) return;
        const cols: (keyof JourneyAttempt)[] = [
            "transactionId", "treeName", "outerTreeName", "isInner", "outcome",
            "startedAt", "completedAt", "realm", "userId", "failureNode", "failureNodeOutcome",
        ];
        const escape = (v: unknown) => {
            const s = v === undefined || v === null ? "" : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const rows = [cols.join(",")];
        for (const a of report.attempts) rows.push(cols.map((c) => escape(a[c])).join(","));
        const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `journey-history-${env}-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    const filteredAttempts = useMemo(() => {
        if (!report) return [];
        return report.attempts.filter((a) => {
            if (scope === "outer" && a.isInner) return false;
            if (scope === "inner" && !a.isInner) return false;
            if (attemptFilter === "fail" && a.outcome !== "fail") return false;
            if (attemptFilter === "incomplete" && a.outcome !== "incomplete") return false;
            return true;
        });
    }, [report, scope, attemptFilter]);

    const scopedPerJourney = useMemo(() => {
        if (!report) return [];
        if (scope === "all") return report.perJourney;
        // Recompute scoped rollup so percentages reflect the toggle.
        const map = new Map<string, { treeName: string; attempts: number; success: number; fail: number; incomplete: number }>();
        for (const a of report.attempts) {
            if (scope === "outer" && a.isInner) continue;
            if (scope === "inner" && !a.isInner) continue;
            const cur = map.get(a.treeName) ?? { treeName: a.treeName, attempts: 0, success: 0, fail: 0, incomplete: 0 };
            cur.attempts++;
            if (a.outcome === "success") cur.success++;
            else if (a.outcome === "fail") cur.fail++;
            else cur.incomplete++;
            map.set(a.treeName, cur);
        }
        return Array.from(map.values())
            .map((r) => {
                const denom = r.attempts - r.incomplete;
                return { ...r, failRate: denom > 0 ? r.fail / denom : 0 };
            })
            .sort((a, b) => b.attempts - a.attempts);
    }, [report, scope]);

    const scopedSummary = useMemo(() => {
        if (!report) return null;
        const a = filteredAttempts;
        return {
            attempts: a.length,
            success: a.filter((x) => x.outcome === "success").length,
            fail: a.filter((x) => x.outcome === "fail").length,
            incomplete: a.filter((x) => x.outcome === "incomplete").length,
        };
    }, [report, filteredAttempts]);

    return (
        <div className="space-y-4">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Environment</span>
                        <select
                            value={env}
                            onChange={(e) => setEnv(e.target.value)}
                            className="w-full rounded border border-slate-300 px-2 py-1.5 bg-white"
                        >
                            {environments.map((e) => (
                                <option key={e.name} value={e.name}>{e.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">From</span>
                        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)}
                            className="w-full rounded border border-slate-300 px-2 py-1.5 bg-white" />
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">To</span>
                        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)}
                            className="w-full rounded border border-slate-300 px-2 py-1.5 bg-white" />
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Journey filter (optional)</span>
                        <input type="text" value={treeName} onChange={(e) => setTreeName(e.target.value)}
                            placeholder="exact treeName"
                            className="w-full rounded border border-slate-300 px-2 py-1.5 bg-white" />
                    </label>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Scope</span>
                        <select value={scope} onChange={(e) => setScope(e.target.value as ScopeFilter)}
                            className="rounded border border-slate-300 px-2 py-1.5 bg-white">
                            <option value="outer">Outer journeys only</option>
                            <option value="inner">Inner journeys only</option>
                            <option value="all">All (outer + inner)</option>
                        </select>
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Source</span>
                        <select
                            value={dataSource}
                            onChange={(e) => setDataSource(e.target.value as "live" | "archive")}
                            className="rounded border border-slate-300 px-2 py-1.5 bg-white"
                        >
                            <option value="live">Live (AIC)</option>
                            <option value="archive">Local archive</option>
                        </select>
                    </label>
                    <label className="text-sm">
                        <span className="block text-slate-600 mb-1">Max events</span>
                        <input type="number" min={100} max={100000} step={1000} value={maxEvents}
                            onChange={(e) => setMaxEvents(Number(e.target.value) || 20000)}
                            className="w-32 rounded border border-slate-300 px-2 py-1.5 bg-white" />
                    </label>
                    <button
                        type="button"
                        onClick={run}
                        disabled={loading}
                        className="rounded bg-sky-600 px-4 py-1.5 text-white text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
                    >
                        {loading ? "Running..." : "Run report"}
                    </button>
                    {report ? (
                        <button
                            type="button"
                            onClick={exportAttemptsCsv}
                            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                        >
                            Export attempts CSV
                        </button>
                    ) : null}
                    {loading ? (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-sky-600" />
                            {scanProgress
                                ? <span>Scanning… page {scanProgress.page} · {scanProgress.rawFetched.toLocaleString()} raw · {scanProgress.matched.toLocaleString()} journey events</span>
                                : <span>Starting scan…</span>}
                        </div>
                    ) : null}
                </div>
                {error ? <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{error}</div> : null}
            </div>

            {report && scopedSummary ? (
                <>
                    {report.source === "archive" && report.coverage && report.coverage !== "full" ? (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            {report.coverage === "none"
                                ? "This window isn't in the local archive yet — run a log pull for this range, or switch Source to Live (AIC)."
                                : "The local archive only partially covers this window — results may be incomplete. Pull the missing range, or switch to Live (AIC)."}
                        </div>
                    ) : report.source === "archive" ? (
                        <div className="text-xs text-slate-500">Served from the local archive.</div>
                    ) : null}
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <Stat label="Attempts" value={scopedSummary.attempts} />
                        <Stat label="Success" value={scopedSummary.success} tone="emerald"
                            sub={scopedSummary.attempts ? `${Math.round((scopedSummary.success / scopedSummary.attempts) * 100)}%` : undefined} />
                        <Stat label="Fail" value={scopedSummary.fail} tone="rose"
                            sub={scopedSummary.attempts ? `${Math.round((scopedSummary.fail / scopedSummary.attempts) * 100)}%` : undefined} />
                        <Stat label="Incomplete" value={scopedSummary.incomplete} tone="amber"
                            sub={scopedSummary.attempts ? `${Math.round((scopedSummary.incomplete / scopedSummary.attempts) * 100)}%` : undefined} />
                        <Stat label="Events scanned" value={report.eventsFetched ?? report.summary.eventsProcessed}
                            sub={report.truncated
                                ? "TRUNCATED — raise Max events or narrow window"
                                : `${report.pagesFetched ?? 0} pages${typeof report.rawFetched === "number" ? ` · raw ${report.rawFetched}` : ""}`} />
                    </div>
                    <ScanDetails report={report} defaultOpen={report.summary.attempts === 0} />
                    {report.summary.attempts === 0 ? (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            No journey attempts found in the window.
                            {typeof report.rawFetched === "number" && report.rawFetched === 0
                                ? " AIC returned 0 raw events — check that this environment has am-authentication logs enabled, that the time range covers actual traffic, and that the Log API credentials in `environments/<env>/log-api.json` are valid."
                                : typeof report.rawFetched === "number" && report.rawFetched > 0
                                    ? " AIC returned events, but none were AM-TREE-LOGIN-COMPLETED (journey-end) events — which is what attempts are anchored on (AM-TREE-LOGIN-INITIATED is optional). Your tenant may emit different event names — see the event-name list in Scan details above and let us know which one marks a journey ending."
                                    : ""}
                        </div>
                    ) : null}

                    <div className="rounded-md border border-slate-200 bg-white">
                        <div className="px-4 py-2 border-b border-slate-200 flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-slate-700">Per-journey rollup</h3>
                            <div className="text-xs text-slate-500">{scopedPerJourney.length} journeys</div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-slate-50 text-slate-600">
                                    <tr>
                                        <th className="text-left px-3 py-2 font-medium">Journey</th>
                                        <th className="text-right px-3 py-2 font-medium">Attempts</th>
                                        <th className="text-right px-3 py-2 font-medium">Success</th>
                                        <th className="text-right px-3 py-2 font-medium">Fail</th>
                                        <th className="text-right px-3 py-2 font-medium">Incomplete</th>
                                        <th className="text-right px-3 py-2 font-medium">Fail rate</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {scopedPerJourney.map((p) => (
                                        <tr key={p.treeName} className="border-t border-slate-100">
                                            <td className="px-3 py-2 font-mono text-xs">{p.treeName}</td>
                                            <td className="px-3 py-2 text-right">{p.attempts}</td>
                                            <td className="px-3 py-2 text-right text-emerald-700">{p.success}</td>
                                            <td className="px-3 py-2 text-right text-rose-700">{p.fail}</td>
                                            <td className="px-3 py-2 text-right text-amber-700">{p.incomplete}</td>
                                            <td className="px-3 py-2 text-right">{(p.failRate * 100).toFixed(1)}%</td>
                                        </tr>
                                    ))}
                                    {scopedPerJourney.length === 0 ? (
                                        <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No attempts in window.</td></tr>
                                    ) : null}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className="rounded-md border border-slate-200 bg-white">
                        <div className="px-4 py-2 border-b border-slate-200 flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-slate-700">Attempts</h3>
                            <div className="flex items-center gap-2 text-xs">
                                <span className="text-slate-500">Filter:</span>
                                {(["all", "fail", "incomplete"] as AttemptFilter[]).map((f) => (
                                    <button key={f} type="button" onClick={() => setAttemptFilter(f)}
                                        className={`px-2 py-0.5 rounded border ${attemptFilter === f
                                            ? "bg-sky-600 text-white border-sky-600"
                                            : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}>
                                        {f}
                                    </button>
                                ))}
                                <span className="text-slate-500 ml-2">{filteredAttempts.length} rows</span>
                            </div>
                        </div>
                        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                            <table className="w-full text-xs">
                                <thead className="bg-slate-50 text-slate-600 sticky top-0">
                                    <tr>
                                        <th className="text-left px-3 py-2 font-medium">Started</th>
                                        <th className="text-left px-3 py-2 font-medium">Journey</th>
                                        <th className="text-left px-3 py-2 font-medium">Outcome</th>
                                        <th className="text-left px-3 py-2 font-medium">User</th>
                                        <th className="text-left px-3 py-2 font-medium">Realm</th>
                                        <th className="text-left px-3 py-2 font-medium">Failure node</th>
                                        <th className="text-left px-3 py-2 font-medium">Transaction</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredAttempts.slice(0, 500).map((a, i) => (
                                        <tr key={`${a.transactionId}-${a.treeName}-${i}`} className="border-t border-slate-100">
                                            <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{a.startedAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}</td>
                                            <td className="px-3 py-1.5 font-mono">
                                                {a.treeName}
                                                {a.isInner ? <span className="ml-1 text-[10px] text-slate-500">(inner of {a.outerTreeName})</span> : null}
                                            </td>
                                            <td className="px-3 py-1.5">
                                                <span className={
                                                    a.outcome === "success" ? "text-emerald-700"
                                                        : a.outcome === "fail" ? "text-rose-700"
                                                            : "text-amber-700"
                                                }>{a.outcome}</span>
                                            </td>
                                            <td className="px-3 py-1.5">{a.userId ?? "—"}</td>
                                            <td className="px-3 py-1.5">{a.realm ?? "—"}</td>
                                            <td className="px-3 py-1.5">{a.failureNode ? `${a.failureNode}${a.failureNodeOutcome ? ` (${a.failureNodeOutcome})` : ""}` : "—"}</td>
                                            <td className="px-3 py-1.5 font-mono text-slate-500">{a.transactionId.slice(0, 12)}…</td>
                                        </tr>
                                    ))}
                                    {filteredAttempts.length === 0 ? (
                                        <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No attempts match the current filter.</td></tr>
                                    ) : null}
                                </tbody>
                            </table>
                            {filteredAttempts.length > 500 ? (
                                <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-200 bg-slate-50">
                                    Showing first 500 of {filteredAttempts.length} rows. Export CSV for the full set.
                                </div>
                            ) : null}
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}
