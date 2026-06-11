import { describe, it, expect } from "vitest";
import { ThrottleGovernor, CLEAN_TO_CLEAR, CLEAN_TO_RECOVER } from "./journey-throttle-governor";
import { AUTO_BUMP_MS, MAX_BUMP_MS } from "@/lib/logs/log-fetch";

const clean = (g: ThrottleGovernor, n: number) => { for (let i = 0; i < n; i++) g.onPage(false); };

describe("ThrottleGovernor", () => {
  it("starts un-throttled at the base settings", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4, baseMaxRetries: 6 });
    expect(g.throttles).toBe(0);
    expect(g.isThrottling()).toBe(false);
    expect(g.targetConcurrency()).toBe(4);
    expect(g.floorMs()).toBe(0);
    expect(g.maxRetries()).toBe(6);
  });

  it("seeds the cumulative throttle count (for resume)", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4, seedThrottles: 3 });
    expect(g.throttles).toBe(3);
    expect(g.isThrottling()).toBe(false); // a resumed run starts un-throttled
  });

  it("marks active and raises the pacing floor on each 429", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4 });
    g.onThrottle(2000, 1);
    expect(g.isThrottling()).toBe(true);
    expect(g.throttles).toBe(1);
    expect(g.lastWaitMs).toBe(2000);
    expect(g.lastAttempt).toBe(1);
    expect(g.floorMs()).toBe(AUTO_BUMP_MS);
    g.onThrottle(2000, 2);
    expect(g.floorMs()).toBe(AUTO_BUMP_MS * 2);
  });

  it("caps the pacing floor at MAX_BUMP_MS", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4 });
    for (let i = 0; i < 1000; i++) g.onThrottle(1000, 1);
    expect(g.floorMs()).toBe(MAX_BUMP_MS);
  });

  it("lowers concurrency by one per throttled page, floored at one", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4 });
    g.onPage(true);
    expect(g.targetConcurrency()).toBe(3);
    g.onPage(true);
    expect(g.targetConcurrency()).toBe(2);
    g.onPage(true); g.onPage(true); g.onPage(true);
    expect(g.targetConcurrency()).toBe(1); // never below 1
  });

  it("clears the active flag after CLEAN_TO_CLEAR clean pages", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4 });
    g.onThrottle(1000, 1);
    expect(g.isThrottling()).toBe(true);
    clean(g, CLEAN_TO_CLEAR - 1);
    expect(g.isThrottling()).toBe(true); // not yet
    g.onPage(false);
    expect(g.isThrottling()).toBe(false);
  });

  it("a throttled page resets the clean streak toward clearing", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4 });
    g.onThrottle(1000, 1);
    clean(g, CLEAN_TO_CLEAR - 1);
    g.onPage(true); // throttled again — streak resets
    clean(g, CLEAN_TO_CLEAR - 1);
    expect(g.isThrottling()).toBe(true);
  });

  it("recovers concurrency by one only after CLEAN_TO_RECOVER clean pages, capped at base", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4 });
    g.onPage(true); g.onPage(true); // 4 -> 2
    expect(g.targetConcurrency()).toBe(2);
    clean(g, CLEAN_TO_RECOVER - 1);
    expect(g.targetConcurrency()).toBe(2); // not yet
    g.onPage(false);
    expect(g.targetConcurrency()).toBe(3); // +1
    clean(g, CLEAN_TO_RECOVER);
    expect(g.targetConcurrency()).toBe(4); // +1, capped at base
    clean(g, CLEAN_TO_RECOVER);
    expect(g.targetConcurrency()).toBe(4); // never above base
  });

  it("decays the pacing floor when concurrency recovers", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4 });
    for (let i = 0; i < 10; i++) g.onThrottle(1000, 1); // floor up
    g.onPage(true); // drop concurrency so there is room to recover
    const before = g.floorMs();
    clean(g, CLEAN_TO_RECOVER);
    expect(g.floorMs()).toBeLessThan(before);
  });

  it("extends the retry budget under sustained throttling and resets on a clean page", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4, baseMaxRetries: 6 });
    expect(g.maxRetries()).toBe(6);
    g.onPage(true);
    expect(g.maxRetries()).toBe(7);
    g.onPage(true); g.onPage(true);
    expect(g.maxRetries()).toBe(9);
    g.onPage(false);
    expect(g.maxRetries()).toBe(6); // back to base once a page comes through clean
  });

  it("caps the retry budget", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 4, baseMaxRetries: 6 });
    for (let i = 0; i < 100; i++) g.onPage(true);
    expect(g.maxRetries()).toBe(12); // base + 6
  });

  it("slams everything to the floor on a full rate-limit episode", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 5, baseMaxRetries: 6 });
    g.onRateLimitEpisode();
    expect(g.targetConcurrency()).toBe(1);     // retry sequentially
    expect(g.floorMs()).toBe(MAX_BUMP_MS);     // pace maximally
    expect(g.maxRetries()).toBe(12);           // give each page the most chances
    expect(g.isThrottling()).toBe(true);
  });

  it("recovers normally after a rate-limit episode once pages flow clean", () => {
    const g = new ThrottleGovernor({ baseConcurrency: 5 });
    g.onRateLimitEpisode();
    expect(g.targetConcurrency()).toBe(1);
    for (let i = 0; i < CLEAN_TO_RECOVER; i++) g.onPage(false);
    expect(g.targetConcurrency()).toBe(2);     // climbs back, one clean run at a time
    expect(g.isThrottling()).toBe(false);
  });
});
