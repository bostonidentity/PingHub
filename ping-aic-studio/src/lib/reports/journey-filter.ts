import type { RawAuthEvent } from "./journey-history";

/**
 * Above this many selected journeys, skip the server-side OR clause (URL length
 * + diminishing returns vs. selecting nearly everything) and filter at analysis
 * time instead.
 */
export const MAX_SERVER_FILTER_JOURNEYS = 25;

/** treeName lives at entries[0].info.treeName (array element), or occasionally payload.treeName. */
function treeNameOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.treeName === "string") return p.treeName;
  const entries = p.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    const info = (entries[0] as Record<string, unknown>)?.info;
    if (info && typeof info === "object") {
      const t = (info as Record<string, unknown>).treeName;
      if (typeof t === "string") return t;
    }
  }
  return undefined;
}

/**
 * Drop embedded double-quotes so a name can't break the queryFilter expression.
 * Journey names come from config directory names and never contain quotes in
 * practice, so this is a defensive guard; if a name ever did contain a quote,
 * stripping it would change which journey is matched (acceptable for this guard).
 */
function escapeFilterValue(name: string): string {
  return name.replace(/"/g, "");
}

/**
 * Build the AIC `_queryFilter`. When 1..MAX_SERVER_FILTER_JOURNEYS journeys are
 * given, AND an OR of exact treeName matches onto the base event-name clause so
 * the tenant returns only those journeys' events. Empty (or over the cap) → base
 * clause unchanged.
 *
 * Uses the ARRAY-IMPLICIT path `/payload/entries/info/treeName` (NO numeric
 * index): AIC matches any array element this way, and the result is exact
 * (verified against the uat tenant). The indexed `/entries/0/...` path silently
 * returns nothing — do not use it.
 */
export function buildJourneyQueryFilter(baseFilter: string, treeNames: string[]): string {
  if (treeNames.length === 0 || treeNames.length > MAX_SERVER_FILTER_JOURNEYS) return baseFilter;
  const or = treeNames
    .map((n) => `/payload/entries/info/treeName eq "${escapeFilterValue(n)}"`)
    .join(" or ");
  return `(${baseFilter}) and (${or})`;
}

/**
 * Exact-set analysis-time filter: keep events whose journey is in `treeNames`.
 * Empty set → events returned unchanged (same reference). Used by the archive
 * source and the >MAX_SERVER_FILTER_JOURNEYS live fallback.
 * Filtering is per-event (by each event's own treeName), matching the
 * server-side query filter's semantics — not the older transaction-based filter.
 */
export function filterEventsByJourneys(events: RawAuthEvent[], treeNames: string[]): RawAuthEvent[] {
  if (treeNames.length === 0) return events;
  const want = new Set(treeNames);
  return events.filter((e) => {
    const t = treeNameOf(e.payload);
    return t !== undefined && want.has(t);
  });
}
