import { describe, it, expect } from "vitest";
import { filterJourneyOptions } from "./journey-search";

describe("filterJourneyOptions", () => {
  const all = ["Login", "kyid_2B1_MasterLogin", "Agent"];

  it("returns all options for an empty query", () => {
    expect(filterJourneyOptions(all, "  ")).toBe(all);
  });

  it("matches case-insensitive substrings", () => {
    expect(filterJourneyOptions(all, "login")).toEqual(["Login", "kyid_2B1_MasterLogin"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterJourneyOptions(all, "zzz")).toEqual([]);
  });
});
