import { describe, it, expect } from "vitest";
import { pLimit } from "@/lib/rcs/p-limit";

describe("pLimit", () => {
  it("runs tasks and resolves with their results", async () => {
    const limit = pLimit(2);
    const results = await Promise.all([limit(() => Promise.resolve(1)), limit(() => Promise.resolve(2))]);
    expect(results).toEqual([1, 2]);
  });

  it("never runs more than N tasks concurrently", async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const task = async (ms: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return ms;
    };
    await Promise.all(Array.from({ length: 6 }, () => limit(() => task(10))));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("still drains the queue when a task rejects", async () => {
    const limit = pLimit(1);
    const first = limit(() => Promise.reject(new Error("boom"))).catch((e) => e.message);
    const second = limit(() => Promise.resolve("after"));
    await expect(first).resolves.toBe("boom");
    await expect(second).resolves.toBe("after");
  });
});
