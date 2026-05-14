export type HealthStatus = "healthy" | "unhealthy" | "unknown";

export interface HealthCacheEntry {
  /** ISO timestamp of the most recent probe attempt. */
  checkedAt: string;
  status: HealthStatus;
  /** HTTP status code from the probe response, when reachable. */
  httpStatus?: number;
  /** Round-trip latency in milliseconds for the probe. */
  latencyMs?: number;
  /** Error message when the probe failed (network/timeout/non-200). */
  error?: string;
}

export interface HealthSettings {
  /** Probe cadence in minutes. Defaults to 15. Min 1, max 1440 (24h). */
  intervalMinutes: number;
}

export const DEFAULT_HEALTH_INTERVAL_MIN = 15;
export const MIN_HEALTH_INTERVAL_MIN = 1;
export const MAX_HEALTH_INTERVAL_MIN = 1440;
