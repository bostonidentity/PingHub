// Lightweight client-side store for "go to this job" navigation from the
// unfinished-jobs panel (which lives in the Data layout, above the Browse/Pull
// tabs) to the actual job card on the Pull page. URL params would need a
// Suspense boundary for useSearchParams (which this codebase avoids), so a
// module-level pub/sub is simpler and works both across a route change
// (consumed on mount via getFocus) and in place (delivered via subscribeFocus).

export type PullMode = "managed" | "logs";

export interface PullFocus {
  mode: PullMode;
  env: string;
  jobId: string;
}

let current: PullFocus | null = null;
const listeners = new Set<(f: PullFocus) => void>();

/** Record a navigation target and notify any mounted listeners synchronously. */
export function focusJob(f: PullFocus): void {
  current = f;
  for (const l of [...listeners]) l(f);
}

/** The pending target — read once by a view that just mounted, then cleared. */
export function getFocus(): PullFocus | null {
  return current;
}

/** Clear the pending target after a view has acted on it. */
export function clearFocus(): void {
  current = null;
}

export function subscribeFocus(l: (f: PullFocus) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
