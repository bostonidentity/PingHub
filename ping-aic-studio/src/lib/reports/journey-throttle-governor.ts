import { AUTO_BUMP_MS, MAX_BUMP_MS } from "@/lib/logs/log-fetch";

// Consecutive clean pages required before the run considers itself recovered.
/** Clear the "actively throttling" flag (hides the banner) after this many clean pages. */
export const CLEAN_TO_CLEAR = 3;
/** Step parallel windows back up by one (and decay pacing) after this many clean pages. */
export const CLEAN_TO_RECOVER = 4;

const MIN_CONCURRENCY = 1;
/** Most extra retries the budget can grow by while throttling persists. */
const RETRY_EXTRA_CAP = 6;
/** How much of the accumulated pacing floor a recovery step sheds. */
const FLOOR_DECAY_MS = AUTO_BUMP_MS * 4;

export interface ThrottleGovernorOpts {
  /** The user's "Parallel windows" setting — the ceiling concurrency recovers toward. */
  baseConcurrency: number;
  /** Per-page 429 retry budget when un-throttled (default 6, matching fetchLogPage). */
  baseMaxRetries?: number;
  /** Cumulative throttle count carried over from a resumed run. */
  seedThrottles?: number;
}

/**
 * Decides how a journey-report run reacts to AIC throughput 429s — the single place
 * that owns adaptive pacing, parallel-window concurrency, the per-page retry budget,
 * and whether the run is *currently* being throttled (which drives the UI banner).
 *
 * Pure and dependency-free: driven by `onThrottle` (a 429 backed off) and `onPage`
 * (a page completed, throttled or clean). Asymmetric by design — concurrency drops
 * fast under pressure and climbs back slowly, so it settles instead of oscillating.
 */
export class ThrottleGovernor {
  throttles: number;
  lastWaitMs?: number;
  lastAttempt?: number;

  private readonly baseConcurrency: number;
  private readonly baseRetries: number;
  private floor = 0;
  private target: number;
  private cleanStreak = 0;
  private throttledStreak = 0;
  private active = false;

  constructor(opts: ThrottleGovernorOpts) {
    this.baseConcurrency = Math.max(MIN_CONCURRENCY, opts.baseConcurrency);
    this.baseRetries = opts.baseMaxRetries ?? 6;
    this.target = this.baseConcurrency;
    this.throttles = opts.seedThrottles ?? 0;
  }

  /** A 429 forced a backoff (wired into fetchLogPage's onThrottle). */
  onThrottle(waitMs: number, attempt: number): void {
    this.throttles++;
    this.lastWaitMs = waitMs;
    this.lastAttempt = attempt;
    this.floor = Math.min(MAX_BUMP_MS, this.floor + AUTO_BUMP_MS);
    this.active = true;
    this.cleanStreak = 0;
  }

  /** A page finished. `throttled` = it saw at least one 429 along the way. */
  onPage(throttled: boolean): void {
    if (throttled) {
      this.throttledStreak++;
      this.cleanStreak = 0;
      this.active = true;
      this.target = Math.max(MIN_CONCURRENCY, this.target - 1);
      return;
    }
    this.throttledStreak = 0;
    this.cleanStreak++;
    if (this.active && this.cleanStreak >= CLEAN_TO_CLEAR) this.active = false;
    if (this.cleanStreak >= CLEAN_TO_RECOVER) {
      this.cleanStreak = 0; // require a fresh clean run before the next step up
      if (this.target < this.baseConcurrency) this.target++;
      this.floor = Math.max(0, this.floor - FLOOR_DECAY_MS);
    }
  }

  /**
   * A full rate-limit episode: the per-page retry budget was exhausted and the run
   * is about to cool down and retry. Slam every lever to its most defensive setting
   * so the retry restarts sequentially, paced maximally, with the largest retry
   * budget — then it ramps back up through clean pages like any other recovery.
   */
  onRateLimitEpisode(): void {
    this.target = MIN_CONCURRENCY;
    this.floor = MAX_BUMP_MS;
    this.throttledStreak = RETRY_EXTRA_CAP;
    this.cleanStreak = 0;
    this.active = true;
  }

  /** Current inter-page pacing floor (ms). */
  floorMs(): number {
    return this.floor;
  }

  /** Current desired number of parallel windows. */
  targetConcurrency(): number {
    return this.target;
  }

  /** Per-page 429 retry budget — grows while throttling, resets when a page comes through clean. */
  maxRetries(): number {
    return this.baseRetries + Math.min(RETRY_EXTRA_CAP, this.throttledStreak);
  }

  /** True while the run is actively being throttled — drives the UI banner. */
  isThrottling(): boolean {
    return this.active;
  }
}
