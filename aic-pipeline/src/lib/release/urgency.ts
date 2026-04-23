import type { UpgradeUrgency } from "./types";

const MS_PER_DAY = 86_400_000;
const DEFAULT_SOON_DAYS = 14;

function parseISO(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function daysUntil(nextUpgrade: string | null | undefined, now: number = Date.now()): number | null {
  const t = parseISO(nextUpgrade ?? null);
  if (t === null) return null;
  return Math.floor((t - now) / MS_PER_DAY);
}

export interface ClassifyOpts {
  soonDays?: number;
}

export function classifyUpgrade(
  nextUpgrade: string | null | undefined,
  now: number = Date.now(),
  opts: ClassifyOpts = {},
): UpgradeUrgency {
  const t = parseISO(nextUpgrade ?? null);
  if (t === null) return "unknown";
  if (t < now) return "overdue";
  const soonDays = opts.soonDays ?? DEFAULT_SOON_DAYS;
  const days = (t - now) / MS_PER_DAY;
  return days <= soonDays ? "soon" : "later";
}
