"use client";

import type { LogPullJob } from "@/lib/logs/log-job-types";

const STATUS_STYLE: Record<LogPullJob["status"], string> = {
    queued: "bg-slate-100 text-slate-600",
    running: "bg-sky-100 text-sky-700",
    aborting: "bg-amber-100 text-amber-700",
    completed: "bg-emerald-100 text-emerald-700",
    failed: "bg-rose-100 text-rose-700",
    aborted: "bg-slate-100 text-slate-500",
    interrupted: "bg-amber-100 text-amber-800",
    suspending: "bg-indigo-100 text-indigo-700",
    suspended: "bg-indigo-100 text-indigo-800",
};

function timeAgo(ms: number): string {
    const delta = Math.max(0, Date.now() - ms);
    if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    return new Date(ms).toLocaleTimeString();
}

const SOURCE_DOT: Record<string, string> = {
    done: "bg-emerald-500",
    failed: "bg-rose-500",
    running: "bg-sky-500 animate-pulse",
    pending: "bg-slate-300",
};

export function LogJobCard({
    job,
    onSuspend,
    onResume,
}: {
    job: LogPullJob;
    onSuspend?: () => void;
    onResume?: () => void;
}) {
    const canSuspend = job.status === "running" || job.status === "queued";
    const canResume = job.status === "interrupted" || job.status === "suspended";
    const totalFetched = job.progress.reduce((s, p) => s + p.fetched, 0);
    const totalStored = job.progress.reduce((s, p) => s + p.stored, 0);

    return (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${STATUS_STYLE[job.status]}`}>{job.status}</span>
                <span className="text-xs font-mono text-slate-500">
                    {new Date(job.from).toLocaleString()} → {new Date(job.to).toLocaleString()}
                </span>
                <span className="ml-auto text-xs text-slate-500 tabular-nums">
                    {totalStored.toLocaleString()} stored · {totalFetched.toLocaleString()} fetched
                </span>
                {canSuspend && onSuspend ? (
                    <button type="button" onClick={onSuspend}
                        className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-50">Suspend</button>
                ) : null}
                {canResume && onResume ? (
                    <button type="button" onClick={onResume}
                        className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-50">Resume</button>
                ) : null}
            </div>
            <div className="text-xs text-slate-400">
                started {timeAgo(job.startedAt)}{job.fatalError ? ` · ${job.fatalError}` : ""}
            </div>
            <ul className="space-y-1">
                {job.progress.map((p) => (
                    <li key={p.source} className="flex items-center gap-2 text-xs">
                        <span className={`inline-block w-2 h-2 rounded-full ${SOURCE_DOT[p.status] ?? "bg-slate-300"}`} />
                        <span className="font-mono text-slate-600 flex-1 truncate">{p.source}</span>
                        <span className="text-slate-500 tabular-nums">{p.stored.toLocaleString()} / {p.fetched.toLocaleString()}</span>
                        {p.error
                            ? <span className="text-rose-600 truncate max-w-[40%]" title={p.error}>{p.error}</span>
                            : <span className="text-slate-400">{p.status}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}
