import { describe, it, expect } from "vitest";
import { buildJourneyQueryFilter, filterEventsByJourneys, MAX_SERVER_FILTER_JOURNEYS } from "./journey-filter";
import type { RawAuthEvent } from "./journey-history";

const BASE = '(/payload/eventName co "AM-TREE-LOGIN-")';
const ev = (tree: string): RawAuthEvent => ({
  timestamp: "2026-06-01T00:00:00Z",
  payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: "t", entries: [{ info: { treeName: tree } }] },
});

describe("buildJourneyQueryFilter", () => {
  it("returns the base filter unchanged when no journeys are selected", () => {
    expect(buildJourneyQueryFilter(BASE, [])).toBe(BASE);
  });

  it("ANDs an OR of exact treeName matches using the array-implicit path", () => {
    expect(buildJourneyQueryFilter(BASE, ["A", "B"]))
      .toBe(`(${BASE}) and (/payload/entries/info/treeName eq "A" or /payload/entries/info/treeName eq "B")`);
  });

  it("strips embedded double-quotes from journey names", () => {
    expect(buildJourneyQueryFilter(BASE, ['a"b']))
      .toBe(`(${BASE}) and (/payload/entries/info/treeName eq "ab")`);
  });

  it("still builds the clause at exactly the server cap", () => {
    const exactly = Array.from({ length: MAX_SERVER_FILTER_JOURNEYS }, (_, i) => `J${i}`);
    expect(buildJourneyQueryFilter(BASE, exactly)).toContain('/payload/entries/info/treeName eq "J0"');
  });

  it("falls back to the base filter above the server cap", () => {
    const many = Array.from({ length: MAX_SERVER_FILTER_JOURNEYS + 1 }, (_, i) => `J${i}`);
    expect(buildJourneyQueryFilter(BASE, many)).toBe(BASE);
  });
});

describe("filterEventsByJourneys", () => {
  it("keeps only events whose journey is in the set", () => {
    const out = filterEventsByJourneys([ev("A"), ev("B"), ev("C")], ["A", "C"]);
    expect(out).toHaveLength(2);
  });

  it("returns all events when the set is empty", () => {
    const all = [ev("A"), ev("B")];
    expect(filterEventsByJourneys(all, [])).toBe(all);
  });

  it("matches the flat payload.treeName fallback shape", () => {
    const flat: RawAuthEvent = { timestamp: "2026-06-01T00:00:00Z", payload: { eventName: "AM-TREE-LOGIN-COMPLETED", transactionId: "t", treeName: "Flat" } };
    expect(filterEventsByJourneys([flat], ["Flat"])).toHaveLength(1);
    expect(filterEventsByJourneys([flat], ["Other"])).toHaveLength(0);
  });
});
