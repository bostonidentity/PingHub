"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { MonitorCheckResult, MonitorsFile } from "@/lib/monitors/types";
import type { TlsCheckResult, TlsMonitorsFile } from "@/lib/monitors/tls-types";

interface ServerIssue {
    kind: "server";
    id: string;
    label: string;
    status: "down" | "degraded";
    message: string;
}

interface TlsIssue {
    kind: "tls";
    id: string;
    label: string;
    status: "expired" | "error";
    message: string;
}

type Issue = ServerIssue | TlsIssue;

function readJson<T>(key: string): T | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(key);
        if (raw == null) return null;
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export function MonitorWarningBanner() {
    const [issues, setIssues] = useState<Issue[]>([]);
    const [dismissedKey, setDismissedKey] = useState<string | null>(null);
    const [serverCfg, setServerCfg] = useState<MonitorsFile | null>(null);
    const [tlsCfg, setTlsCfg] = useState<TlsMonitorsFile | null>(null);

    // Load configs on mount and refresh every 5 minutes so labels stay current.
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const [a, b] = await Promise.all([
                    fetch("/api/monitors", { cache: "no-store" }).then((r) =>
                        r.ok ? (r.json() as Promise<MonitorsFile>) : null,
                    ),
                    fetch("/api/tls-monitors", { cache: "no-store" }).then((r) =>
                        r.ok ? (r.json() as Promise<TlsMonitorsFile>) : null,
                    ),
                ]);
                if (cancelled) return;
                setServerCfg(a);
                setTlsCfg(b);
            } catch {
                /* ignore */
            }
        };
        void load();
        const id = setInterval(load, 5 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, []);

    // Poll localStorage every 5s + on storage events for cross-tab updates.
    useEffect(() => {
        const recompute = () => {
            const ignoreDegraded =
                readJson<boolean>("monitor.serverStatus.ignoreDegraded") ?? true;
            const serverResults =
                readJson<Record<string, MonitorCheckResult>>("monitor.serverStatus.results") ?? {};
            const tlsResults =
                readJson<Record<string, TlsCheckResult>>("monitor.tls.results") ?? {};

            const next: Issue[] = [];

            const serverLabels = new Map<string, string>();
            const serverEnabled = new Set<string>();
            if (serverCfg) {
                for (const m of serverCfg.monitors) {
                    serverLabels.set(m.id, m.label);
                    if (m.enabled !== false) serverEnabled.add(m.id);
                }
            }
            for (const r of Object.values(serverResults)) {
                // If we know the config, filter to currently-enabled monitors;
                // otherwise show everything (better to over-warn than miss).
                if (serverCfg && !serverEnabled.has(r.id)) continue;
                if (r.status === "down") {
                    next.push({
                        kind: "server",
                        id: r.id,
                        label: serverLabels.get(r.id) ?? r.id,
                        status: "down",
                        message: r.message,
                    });
                } else if (r.status === "degraded" && !ignoreDegraded) {
                    next.push({
                        kind: "server",
                        id: r.id,
                        label: serverLabels.get(r.id) ?? r.id,
                        status: "degraded",
                        message: r.message,
                    });
                }
            }

            const tlsLabels = new Map<string, string>();
            const tlsEnabled = new Set<string>();
            if (tlsCfg) {
                for (const t of tlsCfg.targets) {
                    tlsLabels.set(t.id, t.label);
                    if (t.enabled !== false) tlsEnabled.add(t.id);
                }
            }
            for (const r of Object.values(tlsResults)) {
                if (tlsCfg && !tlsEnabled.has(r.id)) continue;
                if (r.status === "expired" || r.status === "error") {
                    next.push({
                        kind: "tls",
                        id: r.id,
                        label: tlsLabels.get(r.id) ?? r.id,
                        status: r.status,
                        message: r.message,
                    });
                }
            }

            setIssues(next);
        };

        recompute();
        const id = setInterval(recompute, 5000);
        const onStorage = (e: StorageEvent) => {
            if (!e.key) return;
            if (
                e.key === "monitor.serverStatus.results" ||
                e.key === "monitor.tls.results" ||
                e.key === "monitor.serverStatus.ignoreDegraded"
            ) {
                recompute();
            }
        };
        window.addEventListener("storage", onStorage);
        return () => {
            clearInterval(id);
            window.removeEventListener("storage", onStorage);
        };
    }, [serverCfg, tlsCfg]);

    if (issues.length === 0) return null;

    // Build a signature so users can dismiss the *current* set; reappears if it changes.
    const signature = issues
        .map((i) => `${i.kind}:${i.id}:${i.status}`)
        .sort()
        .join("|");
    if (dismissedKey === signature) return null;

    const downCount = issues.filter((i) => i.kind === "server" && i.status === "down").length;
    const degradedCount = issues.filter(
        (i) => i.kind === "server" && i.status === "degraded",
    ).length;
    const tlsCount = issues.filter((i) => i.kind === "tls").length;

    return (
        <div
            role="alert"
            className="border-y border-rose-300 bg-rose-50 text-rose-800 px-4 sm:px-10 py-2 text-sm"
        >
            <div className="max-w-[1600px] mx-auto flex items-start gap-3">
                <span className="inline-block h-2.5 w-2.5 mt-1.5 rounded-full bg-rose-500 animate-pulse shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="font-semibold flex flex-wrap items-center gap-x-2">
                        Service issue detected
                        <span className="font-normal text-xs text-rose-700">
                            {downCount > 0 && `${downCount} down`}
                            {downCount > 0 && (degradedCount > 0 || tlsCount > 0) && " · "}
                            {degradedCount > 0 && `${degradedCount} degraded`}
                            {degradedCount > 0 && tlsCount > 0 && " · "}
                            {tlsCount > 0 && `${tlsCount} TLS`}
                        </span>
                        <Link
                            href="/monitor"
                            className="text-xs underline hover:text-rose-900 ml-auto"
                        >
                            View in Monitor →
                        </Link>
                    </div>
                    <ul className="mt-0.5 text-xs text-rose-700 flex flex-wrap gap-x-3 gap-y-0.5">
                        {issues.slice(0, 6).map((i) => (
                            <li key={`${i.kind}-${i.id}`}>
                                <Link
                                    href={i.kind === "tls" ? "/monitor/tls" : "/monitor/server-status"}
                                    className="underline hover:text-rose-900"
                                >
                                    {i.label}
                                </Link>
                                <span className="text-rose-600"> — {i.status}{i.message ? `: ${i.message}` : ""}</span>
                            </li>
                        ))}
                        {issues.length > 6 && (
                            <li className="text-rose-600">…and {issues.length - 6} more</li>
                        )}
                    </ul>
                </div>
                <button
                    type="button"
                    onClick={() => setDismissedKey(signature)}
                    className="text-rose-500 hover:text-rose-700 text-lg leading-none shrink-0"
                    aria-label="Dismiss"
                    title="Dismiss until the set of issues changes"
                >
                    ×
                </button>
            </div>
        </div>
    );
}
