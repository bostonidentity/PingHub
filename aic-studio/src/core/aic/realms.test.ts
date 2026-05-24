import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { listRealms } from "./realms";

const cache = { get: async () => "t", invalidate: () => {} };

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("listRealms", () => {
  it("returns realm names from global-config/realms", async () => {
    nock("https://prod.id.forgerock.io")
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, {
        result: [
          { _id: "alpha-id", name: "alpha", parentPath: "/" },
          { _id: "bravo-id", name: "bravo", parentPath: "/" }
        ],
        resultCount: 2
      });
    expect(await listRealms("https://prod.id.forgerock.io", cache)).toEqual(["alpha", "bravo"]);
  });

  it("filters out the root realm itself (name '/')", async () => {
    nock("https://prod.id.forgerock.io")
      .get("/am/json/global-config/realms?_queryFilter=true")
      .reply(200, {
        result: [
          { _id: "root-id", name: "/", parentPath: "" },
          { _id: "alpha-id", name: "alpha", parentPath: "/" }
        ],
        resultCount: 2
      });
    expect(await listRealms("https://prod.id.forgerock.io", cache)).toEqual(["alpha"]);
  });
});
