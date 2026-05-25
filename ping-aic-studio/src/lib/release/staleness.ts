/**
 * Returns true when the given fetch timestamp is older than the current UTC
 * calendar day — i.e. the cached release info should be refreshed.
 * Missing, null, empty, or malformed values are also considered stale.
 * A future timestamp is treated as fresh (not stale) so clock skew doesn't
 * trigger unnecessary refreshes.
 */
export function isStaleToday(fetchedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!fetchedAt || typeof fetchedAt !== "string") return true;
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return true;
  const fetched = new Date(t);
  return dayKey(fetched) < dayKey(now);
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
