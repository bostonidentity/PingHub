// Module-level controller for the managed-object count probe.
//
// The probe is a streaming fetch. Keeping it here (not in component state) means
// it SURVIVES tab/route changes — the panel only subscribes for display, so
// switching to Logs / Browse / another tab no longer orphans the work or loses
// progress. Results are persisted to localStorage the moment they arrive,
// independent of React render state, so a probe that finishes while you're away
// is not lost. An AbortController makes the fetch genuinely cancellable — used
// for an explicit Cancel and to supersede an in-flight probe — NOT fired on
// every unmount (which would defeat the survive-navigation goal).

export const PROBE_STORE_KEY = "data-probe-counts-v1";
export const PROBE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
export type ProbedEntry = { count: number | null; reason?: string; probedAt?: number };

export function loadProbes(): Record<string, ProbedEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PROBE_STORE_KEY);
    return raw ? JSON.parse(raw) as Record<string, ProbedEntry> : {};
  } catch { return {}; }
}
function saveProbes(store: Record<string, ProbedEntry>): void {
  try { localStorage.setItem(PROBE_STORE_KEY, JSON.stringify(store)); } catch { /* quota / unavailable */ }
}
export const probeKey = (env: string, type: string) => `${env}::${type}`;

type ProbeEvent =
  | { event: "start"; type: string }
  | { event: "progress"; type: string; fetched: number; pages: number }
  | { event: "done"; type: string; count: number | null; reason?: string }
  | { event: "fatal"; error: string }
  | { event: "end" };

export interface ProbeState {
  probing: boolean;
  /** Env the active (or most recent) probe belongs to — scope progress to it. */
  env: string | null;
  currentlyProbing: string | null;
  progress: Record<string, { fetched: number; pages: number }>;
  error: string | null;
  /** Bumps whenever a result is persisted, so subscribers can re-read localStorage. */
  resultsVersion: number;
}

let state: ProbeState = {
  probing: false, env: null, currentlyProbing: null, progress: {}, error: null, resultsVersion: 0,
};
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<ProbeState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

export function getProbeState(): ProbeState { return state; }

export function subscribeProbe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Cancel the in-flight probe (explicit Cancel button). */
export function abortProbe(): void {
  controller?.abort();
}

/** Persist one type's count immediately — outside any React updater. */
function persistResult(env: string, type: string, count: number | null, reason?: string): void {
  const store = loadProbes();
  const now = Date.now();
  store[probeKey(env, type)] = reason ? { count, reason, probedAt: now } : { count, probedAt: now };
  saveProbes(store);
  set({ resultsVersion: state.resultsVersion + 1 });
}

/**
 * Stream a count probe for `types` in `env`. Survives unmount; aborts any prior
 * in-flight probe first (single probe channel). Returns true on success, false
 * on error or abort.
 */
export async function startProbe(env: string, types: string[]): Promise<boolean> {
  if (!env || types.length === 0) return true;

  controller?.abort();            // supersede any in-flight probe
  const ctl = new AbortController();
  controller = ctl;

  const progress = { ...state.progress };
  for (const t of types) delete progress[t];
  set({ probing: true, env, error: null, currentlyProbing: null, progress });

  try {
    const res = await fetch(`/api/data/count/${env}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ types }),
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      set({ error: `Probe failed (${res.status}).` });
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as ProbeEvent;
          if (ev.event === "start") {
            set({ currentlyProbing: ev.type });
          } else if (ev.event === "progress") {
            set({ progress: { ...state.progress, [ev.type]: { fetched: ev.fetched, pages: ev.pages } } });
          } else if (ev.event === "done") {
            persistResult(env, ev.type, ev.count, ev.reason);
          } else if (ev.event === "fatal") {
            set({ error: ev.error });
            return false;
          }
        } catch { /* ignore malformed line */ }
      }
    }
    return true;
  } catch (e) {
    if ((e as Error).name === "AbortError") return false; // cancelled / superseded
    set({ error: (e as Error).message });
    return false;
  } finally {
    // Only the still-active run clears the flags — a superseded run must not
    // stomp the flags its successor just set.
    if (controller === ctl) {
      controller = null;
      set({ probing: false, currentlyProbing: null });
    }
  }
}
