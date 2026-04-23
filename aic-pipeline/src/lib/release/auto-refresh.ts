import { getEnvironments } from "@/lib/fr-config";
import { readReleaseInfo } from "./persistence";
import { refreshOne } from "./refresh";
import { isStaleToday } from "./staleness";

/**
 * Per-env in-flight guard. Prevents two concurrent page loads from kicking
 * off duplicate refreshes for the same env, which would waste tokens and
 * potentially race on the file write.
 *
 * Stored on globalThis so HMR in dev doesn't accidentally reset it.
 */
const KEY = "__releaseInflight";
const globalRef = globalThis as unknown as Record<string, Set<string> | undefined>;

function inflight(): Set<string> {
  let set = globalRef[KEY];
  if (!set) {
    set = new Set<string>();
    globalRef[KEY] = set;
  }
  return set;
}

export function isAlreadyRefreshing(envName: string): boolean {
  return inflight().has(envName);
}

export function markRefreshing(envName: string): boolean {
  const set = inflight();
  if (set.has(envName)) return false;
  set.add(envName);
  return true;
}

export function markRefreshDone(envName: string): void {
  inflight().delete(envName);
}

export function __resetInflightForTests(): void {
  inflight().clear();
}

/**
 * Fire-and-forget. For every configured env whose cached release info is
 * missing or from a previous UTC day, trigger a refresh in the background
 * without blocking the caller. Safe to call repeatedly — the in-flight
 * guard de-dups concurrent calls, and `isStaleToday` short-circuits when
 * today's refresh already landed.
 */
export function triggerStaleRefreshAsync(): void {
  const envs = getEnvironments();
  for (const e of envs) {
    const cached = readReleaseInfo(e.name);
    if (!isStaleToday(cached?.fetchedAt)) continue;
    if (!markRefreshing(e.name)) continue;
    refreshOne(e.name)
      .catch(() => {
        // refreshOne already persists error entries; swallow here so an
        // unexpected throw in the fire-and-forget branch doesn't crash
        // the process.
      })
      .finally(() => markRefreshDone(e.name));
  }
}
