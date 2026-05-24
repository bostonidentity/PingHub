// src/core/aic/journeys.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { listJourneys, fetchJourney } from "./journeys";

const cache = { get: async () => "test-token", invalidate: () => {} };

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("listJourneys", () => {
  it("returns an array of journey ids for a realm", async () => {
    nock("https://prod.id.forgerock.io")
      .get(/authenticationtrees\?_queryFilter=true/)
      .reply(200, {
        result: [
          { _id: "Login", _rev: "1" },
          { _id: "Registration", _rev: "1" }
        ],
        resultCount: 2
      });

    const ids = await listJourneys("https://prod.id.forgerock.io", "alpha", cache);
    expect(ids).toEqual(["Login", "Registration"]);
  });

  it("returns empty array when realm has no journeys", async () => {
    nock("https://prod.id.forgerock.io")
      .get(/authenticationtrees\?_queryFilter=true/)
      .reply(200, { result: [], resultCount: 0 });
    expect(await listJourneys("https://prod.id.forgerock.io", "alpha", cache)).toEqual([]);
  });
});

describe("fetchJourney", () => {
  it("returns the full journey JSON for an id", async () => {
    nock("https://prod.id.forgerock.io")
      .get(/authenticationtrees\/Login$/)
      .reply(200, { _id: "Login", _rev: "1", entryNodeId: "abc", nodes: {} });

    const j = await fetchJourney("https://prod.id.forgerock.io", "alpha", "Login", cache);
    expect(j._id).toBe("Login");
    expect(j.entryNodeId).toBe("abc");
  });
});
