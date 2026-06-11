/** Case-insensitive substring filter over journey names. Empty query → same array reference. */
export function filterJourneyOptions(all: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((n) => n.toLowerCase().includes(q));
}
