"use client";

import { useEffect, useState } from "react";

/**
 * Shared environment selection across /data/browse and /data/pull. Stored in
 * localStorage so switching between the two sub-tabs (or reloading) keeps the
 * same env selected. State starts at environments[0] to stay deterministic for
 * SSR, then rehydrates from localStorage after mount.
 */
const STORAGE_KEY = "data-env-v1";

export function useDataEnv(environments: { name: string }[]): {
  env: string;
  setEnv: (next: string) => void;
} {
  const [env, setEnv] = useState(environments[0]?.name ?? "");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && environments.some((e) => e.name === saved)) setEnv(saved);
    } catch { /* storage unavailable — stay on default */ }
    // environments is typically stable across a session; rehydrate whenever it
    // changes so adding/removing an env can re-validate the stored value.
  }, [environments]);

  const setEnvWithPersist = (next: string) => {
    setEnv(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  };

  return { env, setEnv: setEnvWithPersist };
}

/** Format a millisecond timestamp as a short relative age ("5m ago"). */
export function timeAgoShort(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
