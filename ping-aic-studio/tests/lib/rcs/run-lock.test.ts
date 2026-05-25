import { describe, it, expect, beforeEach } from "vitest";
import { acquireRunLock, __resetRunLocksForTests } from "@/lib/rcs/run-lock";

beforeEach(() => __resetRunLocksForTests());

describe("acquireRunLock", () => {
  it("returns a release function for an unlocked env", () => {
    const release = acquireRunLock("dev");
    expect(typeof release).toBe("function");
  });

  it("returns null for a second attempt on the same env", () => {
    acquireRunLock("dev");
    expect(acquireRunLock("dev")).toBeNull();
  });

  it("re-acquires after release", () => {
    const release = acquireRunLock("dev");
    expect(release).not.toBeNull();
    release!();
    const next = acquireRunLock("dev");
    expect(next).not.toBeNull();
  });

  it("does not block a different env", () => {
    acquireRunLock("dev");
    expect(acquireRunLock("sit")).not.toBeNull();
  });
});
