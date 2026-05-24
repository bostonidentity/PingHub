// src/core/aic/client.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { createAuthedClient } from "./client";

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("createAuthedClient", () => {
  it("adds Bearer Authorization header to all requests", async () => {
    const scope = nock("https://prod.id.forgerock.io", {
      reqheaders: { authorization: "Bearer test-token" }
    })
      .get("/am/json/anything")
      .reply(200, { ok: true });

    const cache = { get: async () => "test-token", invalidate: () => {} };
    const client = createAuthedClient(cache);
    const res = await client.get("https://prod.id.forgerock.io/am/json/anything");
    expect(res.data).toEqual({ ok: true });
    expect(scope.isDone()).toBe(true);
  });

  it("retries once after a 401 with token invalidation", async () => {
    nock("https://prod.id.forgerock.io").get("/am/json/x").reply(401, { error: "expired" });
    nock("https://prod.id.forgerock.io")
      .get("/am/json/x")
      .reply(200, { ok: true });

    let invalidateCalls = 0;
    const cache = {
      get: async () => "t",
      invalidate: () => { invalidateCalls += 1; }
    };
    const client = createAuthedClient(cache);
    const res = await client.get("https://prod.id.forgerock.io/am/json/x");
    expect(res.data).toEqual({ ok: true });
    expect(invalidateCalls).toBe(1);
  });

  it("propagates non-401 errors", async () => {
    nock("https://prod.id.forgerock.io").get("/am/json/x").reply(500, { error: "boom" });
    const cache = { get: async () => "t", invalidate: () => {} };
    const client = createAuthedClient(cache);
    await expect(
      client.get("https://prod.id.forgerock.io/am/json/x")
    ).rejects.toThrow(/500/);
  });
});
