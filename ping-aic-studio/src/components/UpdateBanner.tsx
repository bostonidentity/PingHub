"use client";

import { useEffect, useState, useCallback } from "react";

interface VersionStatus {
  installed: { version: string; platform: string; arch: string; bundledNode: boolean; source: "package" | "dev" };
  latest: { version: string; htmlUrl: string; asset: { name: string; size: number } | null } | null;
  canUpdate: boolean;
  newerAvailable: boolean;
  reason?: string;
}

type Phase = "idle" | "downloading" | "waiting-for-restart" | "ready" | "error";

const VERSION_POLL_MS = 60 * 60 * 1000; // re-check every hour
const RESTART_POLL_MS = 1500;
const RESTART_TIMEOUT_MS = 120_000;

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- bootstrap fetch
    fetchStatus();
    const t = setInterval(() => fetchStatus(), VERSION_POLL_MS);
    return () => clearInterval(t);
  }, [fetchStatus]);

  // Restore dismissal from sessionStorage so it survives navigation but not restart.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from storage
    setDismissed(typeof window !== "undefined" ? sessionStorage.getItem("pinghub.update.dismissed") : null);
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
