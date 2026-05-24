// src/core/aic/logs.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { queryLogs } from "./logs";

beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

describe("queryLogs", () => {
  it("GETs /monitoring/logs with x-api-key + x-api-secret headers and returns entries", async () => {
    nock("https://prod.id.forgerock.io", {
      reqheaders: {
        "x-api-key": "key-abc",
        "x-api-secret": "secret-xyz"
      }
    })
      .get(/monitoring\/logs/)
      .reply(200, {
        result: [
          { timestamp: "2026-05-24T10:00:00Z", source: "am-everything", type: "info", payload: { msg: "x" } },
          { timestamp: "2026-05-24T10:01:00Z", source: "am-everything", type: "warn", payload: { msg: "y" } }
        ]
      });

    const r = await queryLogs({
      tenantUrl: "https://prod.id.forgerock.io",
      apiKey: "key-abc",
      apiSecret: "secret-xyz",
      source: "am-everything"
    });
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].source).toBe("am-everything");
    expect(r.entries[1].type).toBe("warn");
  });

  it("returns empty result list", async () => {
    nock("https://prod.id.forgerock.io").get(/monitoring\/logs/).reply(200, { result: [] });
    const r = await queryLogs({
      tenantUrl: "https://prod.id.forgerock.io",
      apiKey: "k", apiSecret: "s",
      source: "am"
    });
    expect(r.entries).toEqual([]);
  });

  it("throws on 4xx with status in message", async () => {
    nock("https://prod.id.forgerock.io").get(/monitoring\/logs/).reply(401, { error: "invalid_key" });
    await expect(queryLogs({
      tenantUrl: "https://prod.id.forgerock.io",
      apiKey: "bad", apiSecret: "bad",
      source: "am"
    })).rejects.toThrow(/401/);
  });

  it("includes pagedResultsCookie when AIC returns one", async () => {
    nock("https://prod.id.forgerock.io").get(/monitoring\/logs/).reply(200, {
      result: [],
      pagedResultsCookie: "cookie-abc"
    });
    const r = await queryLogs({
      tenantUrl: "https://prod.id.forgerock.io",
      apiKey: "k", apiSecret: "s",
      source: "am"
    });
    expect(r.pagedResultsCookie).toBe("cookie-abc");
  });
});
