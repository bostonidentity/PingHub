"use client";

import { useEffect, useState, useCallback } from "react";
import { updateNotice } from "@/lib/update-notice";
import { ReleaseNotes } from "@/components/ReleaseNotes";

interface VersionStatus {
    installed: { version: string; platform: string; arch: string; bundledNode: boolean; source: "package" | "dev" };
    latest: { version: string; htmlUrl: string; notes: string | null; asset: { name: string; size: number } | null } | null;
    canUpdate: boolean;
    newerAvailable: boolean;
    reason?: string;
}

type Phase = "idle" | "downloading" | "waiting-for-restart" | "ready" | "error";

const VERSION_POLL_MS = 60 * 60 * 1000; // re-check every hour
const RESTART_POLL_MS = 1500;
const RESTART_TIMEOUT_MS = 120_000;

// One-time popup state, per browser (localStorage). The banner's per-session
// dismissal stays separate (sessionStorage) — popups pop once per version,
// the banner remains the quiet ongoing reminder.
const NOTIFIED_KEY = "pinghub.update.notified";
const LAST_SEEN_KEY = "pinghub.version.lastSeen";
const RELEASES_URL = "https://github.com/bostonidentity/PingHub/releases";

export function UpdateBanner() {
    const [status, setStatus] = useState<VersionStatus | null>(null);
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState<string | null>(null);

    const fetchStatus = useCallback(async (force = false) => {
        try {
            const res = await fetch(`/api/system/version${force ? "?force=1" : ""}`, { cache: "no-store" });
            if (!res.ok) return;
            const data = (await res.json()) as VersionStatus;
            setStatus(data);
        } catch { /* ignore */ }
    }, []);

    // Initial fetch + periodic poll
    useEffect(() => {
         
        fetchStatus();
        const t = setInterval(() => fetchStatus(), VERSION_POLL_MS);
        return () => clearInterval(t);
    }, [fetchStatus]);

    // Restore dismissal from sessionStorage so it survives navigation but not restart.
    useEffect(() => {
         
        setDismissed(typeof window !== "undefined" ? sessionStorage.getItem("pinghub.update.dismissed") : null);
    }, []);

    // One-time popup bookkeeping (per browser). `lastSeen` undefined = not hydrated yet.
    const [notified, setNotified] = useState<string | null>(null);
    const [lastSeen, setLastSeen] = useState<string | null | undefined>(undefined);
    // Upgrade launched from the popup (vs the banner) — keeps the modal open through the phases.
    const [modalUpgrade, setModalUpgrade] = useState(false);
    useEffect(() => {
         
        setNotified(localStorage.getItem(NOTIFIED_KEY));
         
        setLastSeen(localStorage.getItem(LAST_SEEN_KEY));
    }, []);

    // Fresh profile: adopt the current install silently — no what's-new popup
    // for a version the user was already running when the key first appeared.
    useEffect(() => {
        if (lastSeen !== null || !status) return;
        localStorage.setItem(LAST_SEEN_KEY, status.installed.version);
        setLastSeen(status.installed.version);
    }, [lastSeen, status]);

    const markNotified = useCallback((version: string) => {
        localStorage.setItem(NOTIFIED_KEY, version);
        setNotified(version);
    }, []);
    const markSeen = useCallback((version: string) => {
        localStorage.setItem(LAST_SEEN_KEY, version);
        setLastSeen(version);
    }, []);

    const onUpgrade = useCallback(async () => {
        if (!status?.canUpdate) return;
        setError(null);
        setPhase("downloading");
        try {
            const res = await fetch("/api/system/update", { method: "POST" });
            const body = await res.json().catch(() => ({} as { error?: string }));
            if (!res.ok) {
                setError(body.error ?? `update failed (${res.status})`);
                setPhase("error");
                return;
            }
            setPhase("waiting-for-restart");
            const targetVersion = status.latest!.version;
            const startedAt = Date.now();
            const tick = async () => {
                if (Date.now() - startedAt > RESTART_TIMEOUT_MS) {
                    setError("server did not come back within 2 minutes; check manually");
                    setPhase("error");
                    return;
                }
                try {
                    const r = await fetch("/api/system/version", { cache: "no-store" });
                    if (r.ok) {
                        const data = (await r.json()) as VersionStatus;
                        if (data.installed.version === targetVersion) {
                            setPhase("ready");
                            setTimeout(() => window.location.reload(), 800);
                            return;
                        }
                    }
                } catch { /* server down, keep polling */ }
                setTimeout(tick, RESTART_POLL_MS);
            };
            setTimeout(tick, RESTART_POLL_MS);
        } catch (e) {
            setError((e as Error).message);
            setPhase("error");
        }
    }, [status]);

    const dismiss = useCallback(() => {
        if (!status?.latest) return;
        sessionStorage.setItem("pinghub.update.dismissed", status.latest.version);
        setDismissed(status.latest.version);
    }, [status]);

    if (!status) return null;

    // Which one-time popup (if any) is due. Suppressed while an upgrade phase is
    // active and until localStorage has hydrated (lastSeen === undefined).
    const notice = phase === "idle" && lastSeen !== undefined
        ? updateNotice({
            installedVersion: status.installed.version,
            latestVersion: status.latest?.version ?? null,
            newerAvailable: status.newerAvailable,
            notifiedVersion: notified,
            lastSeenVersion: lastSeen,
        })
        : null;
    const modal = renderModal(notice);

    const banner = renderBanner();
    if (!modal && !banner) return null;
    return (
        <>
            {modal}
            {banner}
        </>
    );

    // ── One-time popup (new-version / what's-new), plus upgrade progress when
    // the upgrade was launched from the popup. ──────────────────────────────
    function renderModal(due: ReturnType<typeof updateNotice>): React.ReactNode {
        if (!status) return null;
        const showForUpgrade = modalUpgrade && phase !== "idle";
        if (!due && !showForUpgrade) return null;

        let title: string;
        let content: React.ReactNode;
        if (showForUpgrade) {
            title = `Upgrading to v${status.latest?.version ?? "?"}`;
            content = (
                <div className="text-sm text-slate-700">
                    {phase === "downloading" && <p>Downloading… (this may take ~30s)</p>}
                    {phase === "waiting-for-restart" && <p>Restarting server… your browser will reload when it&apos;s back.</p>}
                    {phase === "ready" && <p>Upgrade complete. Reloading…</p>}
                    {phase === "error" && (
                        <>
                            <p className="text-red-700">Upgrade failed: {error}</p>
                            <div className="mt-4 flex justify-end">
                                <button
                                    onClick={() => { setPhase("idle"); setError(null); setModalUpgrade(false); }}
                                    className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                                >
                                    Dismiss
                                </button>
                            </div>
                        </>
                    )}
                </div>
            );
        } else if (due === "whats-new") {
            // Notes come from `latest` and only describe the running version when they match.
            const notes = status.latest && status.latest.version === status.installed.version ? status.latest.notes : null;
            title = `What's new in v${status.installed.version}`;
            content = (
                <>
                    {notes ? (
                        <ReleaseNotes notes={notes} />
                    ) : (
                        <p className="text-sm text-slate-700">
                            PingHub was updated to v{status.installed.version}.{" "}
                            <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="text-sky-700 underline">View releases</a>
                        </p>
                    )}
                    <div className="mt-4 flex justify-end">
                        <button
                            onClick={() => markSeen(status.installed.version)}
                            className="rounded bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
                        >
                            Got it
                        </button>
                    </div>
                </>
            );
        } else {
            // due === "new-version" — updateNotice only returns it when latest is non-null.
            const latest = status.latest!;
            title = `PingHub v${latest.version} is available`;
            content = (
                <>
                    <p className="mb-2 text-sm text-slate-700">You have v{status.installed.version}.</p>
                    {latest.notes ? (
                        <ReleaseNotes notes={latest.notes} />
                    ) : null}
                    <div className="mt-4 flex justify-end gap-2">
                        <button
                            onClick={() => markNotified(latest.version)}
                            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                        >
                            Later
                        </button>
                        {status.canUpdate ? (
                            <button
                                onClick={() => { markNotified(latest.version); setModalUpgrade(true); onUpgrade(); }}
                                className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                            >
                                Upgrade &amp; restart
                            </button>
                        ) : (
                            <a
                                href={latest.htmlUrl} target="_blank" rel="noreferrer"
                                onClick={() => markNotified(latest.version)}
                                title={status.reason}
                                className="rounded bg-slate-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
                            >
                                View release
                            </a>
                        )}
                    </div>
                </>
            );
        }

        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
                <div className="w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl">
                    <h2 className="mb-3 text-sm font-semibold text-slate-800">{title}</h2>
                    {content}
                </div>
            </div>
        );
    }

    // ── Slim banner — unchanged behavior (per-session dismissal). ───────────
    function renderBanner(): React.ReactNode {
        if (!status || !status.newerAvailable || !status.latest) return null;

        // While dismissed in this session, only show in active phases.
        const isDismissed = dismissed === status.latest.version && phase === "idle";
        if (isDismissed) return null;

        const sizeMb = status.latest.asset ? (status.latest.asset.size / (1024 * 1024)).toFixed(1) : null;

        let body: React.ReactNode = null;
        if (phase === "idle") {
            body = (
                <>
                    <span>
                        Update available: <strong>v{status.latest.version}</strong> (you have v{status.installed.version}
                        {sizeMb && status.canUpdate ? `, download ${sizeMb} MB` : ""})
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                        {status.canUpdate ? (
                            <button
                                onClick={onUpgrade}
                                className="px-3 py-0.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                            >
                                Upgrade & restart
                            </button>
                        ) : (
                            <a
                                href={status.latest.htmlUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-0.5 text-xs font-semibold rounded bg-slate-700 text-white hover:bg-slate-800 transition-colors"
                                title={status.reason}
                            >
                                View release
                            </a>
                        )}
                        <button
                            onClick={dismiss}
                            className="px-2 py-0.5 text-xs text-emerald-900/70 hover:text-emerald-900"
                            title="Dismiss until next session"
                        >
                            ✕
                        </button>
                    </span>
                </>
            );
        } else if (phase === "downloading") {
            body = <span>Downloading v{status.latest.version}… (this may take ~30s)</span>;
        } else if (phase === "waiting-for-restart") {
            body = <span>Restarting server with v{status.latest.version}… your browser will reload when it&apos;s back.</span>;
        } else if (phase === "ready") {
            body = <span>Upgrade complete. Reloading…</span>;
        } else if (phase === "error") {
            body = (
                <>
                    <span>Upgrade failed: {error}</span>
                    <button
                        onClick={() => { setPhase("idle"); setError(null); }}
                        className="ml-auto px-2 py-0.5 text-xs text-red-900 underline hover:no-underline"
                    >
                        Dismiss
                    </button>
                </>
            );
        }

        const tone = phase === "error"
            ? "bg-red-100 border-red-300 text-red-900"
            : phase === "ready"
                ? "bg-emerald-200 border-emerald-400 text-emerald-900"
                : "bg-emerald-100 border-emerald-300 text-emerald-900";

        return (
            <div className={`flex items-center gap-3 px-4 py-1.5 text-xs border-b ${tone}`}>
                {body}
            </div>
        );
    }
}
