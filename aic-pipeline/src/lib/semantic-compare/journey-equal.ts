import type { CanonicalJourney, CanonicalScript, EqualityReason, EqualityResult } from "./types";
import { scriptsEqual } from "./script-equal";

export interface JourneyEqualCtx {
  scriptsA: Map<string, CanonicalScript>;
  scriptsB: Map<string, CanonicalScript>;
  /** Optional inner-journey resolvers for recursion (Task 11). */
  journeysA?: Map<string, CanonicalJourney>;
  journeysB?: Map<string, CanonicalJourney>;
  /** Cycle guard for recursion (Task 11). */
  visited?: Set<string>;
}

export function journeysEqual(
  a: CanonicalJourney,
  b: CanonicalJourney,
  ctx: JourneyEqualCtx,
): EqualityResult {
  const reasons: EqualityReason[] = [];

  // 1. Header deep-equal.
  const headerDiffFields = diffHeaderFields(a.header, b.header);
  if (headerDiffFields.length > 0) reasons.push({ kind: "header", fields: headerDiffFields });

  // 2. Node set equality.
  const keysA = new Set(a.nodes.keys());
  const keysB = new Set(b.nodes.keys());
  const added = [...keysB].filter((k) => !keysA.has(k)).sort();
  const removed = [...keysA].filter((k) => !keysB.has(k)).sort();
  if (added.length > 0 || removed.length > 0) reasons.push({ kind: "node-set", added, removed });

  // 3. Node payload equality for shared keys.
  for (const key of keysA) {
    if (!keysB.has(key)) continue;
    const pa = JSON.stringify(a.nodes.get(key)!.payload);
    const pb = JSON.stringify(b.nodes.get(key)!.payload);
    if (pa !== pb) reasons.push({ kind: "node-settings", stableKey: key });
  }

  // 4. Referenced scripts.
  const refScripts = new Set([...a.referencedScripts, ...b.referencedScripts]);
  for (const id of refScripts) {
    const sa = ctx.scriptsA.get(id);
    const sb = ctx.scriptsB.get(id);
    if (!sa && !sb) continue;
    if (!sa) { reasons.push({ kind: "script-missing", identity: id, side: "source" }); continue; }
    if (!sb) { reasons.push({ kind: "script-missing", identity: id, side: "target" }); continue; }
    const sr = scriptsEqual(sa, sb);
    for (const r of sr.reasons) reasons.push(r);
  }

  // 5. Referenced inner journeys (recursive with cycle guard).
  if (ctx.journeysA && ctx.journeysB) {
    const visited = ctx.visited ?? new Set<string>();
    const refSubs = new Set([...a.referencedSubJourneys, ...b.referencedSubJourneys]);
    for (const name of refSubs) {
      if (visited.has(name)) continue;
      const ja = ctx.journeysA.get(name);
      const jb = ctx.journeysB.get(name);
      if (!ja && !jb) continue;
      if (!ja) { reasons.push({ kind: "subjourney-missing", name, side: "source" }); continue; }
      if (!jb) { reasons.push({ kind: "subjourney-missing", name, side: "target" }); continue; }
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      const sub = journeysEqual(ja, jb, { ...ctx, visited: nextVisited });
      if (!sub.equal) reasons.push({ kind: "subjourney-diff", name, reasons: sub.reasons });
    }
  }

  return { equal: reasons.length === 0, reasons };
}

function diffHeaderFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: string[] = [];
  for (const k of [...keys].sort()) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
  }
  return diffs;
}
