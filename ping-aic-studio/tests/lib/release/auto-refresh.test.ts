import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetInflightForTests,
  isAlreadyRefreshing,
  markRefreshing,
  markRefreshDone,
} from "@/lib/release/auto-refresh";

beforeEach(() => __resetInflightForTests());

describe("inflight guard", () => {
  it("markRefreshing returns true the first time and false thereafter", () => {
    expect(markRefreshing("dev")).toBe(true);
    expect(markRefreshing("dev")).toBe(false);
  });

  it("isAlreadyRefreshing reflects state", () => {
    expect(isAlreadyRefreshing("dev")).toBe(false);
    markRefreshing("dev");
    expect(isAlreadyRefreshing("dev")).toBe(true);
    markRefreshDone("dev");
    expect(isAlreadyRefreshing("dev")).toBe(false);
  });

  it("tracks different envs independently", () => {
    markRefreshing("dev");
    expect(markRefreshing("sit")).toBe(true);
    expect(markRefreshing("dev")).toBe(false);
  });
});
