// src/core/monitors/serverPing.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { checkServerPing } from "./serverPing";

beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

describe("checkServerPing", () => {
  it("returns ok=true with latencyMs on 200", async () => {
    nock("https://prod.id.forgerock.io")
      .post("/am/oauth2/realms/root/access_token")
      .reply(200, { access_token: "x", token_type: "Bearer", expires_in: 3600, scope: "fr:am:*" });
    const r = await checkServerPing({
      tenantUrl: "https://prod.id.forgerock.io",
      clientId: "c", clientSecret: "s"
    });
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok=false with error on 401", async () => {
    nock("https://prod.id.forgerock.io")
      .post("/am/oauth2/realms/root/access_token")
      .reply(401, { error: "invalid_client" });
    const r = await checkServerPing({
      tenantUrl: "https://prod.id.forgerock.io",
      clientId: "c", clientSecret: "s"
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401|invalid_client/i);
  });

  it("returns ok=false on network error", async () => {
    nock("https://prod.id.forgerock.io")
      .post("/am/oauth2/realms/root/access_token")
      .replyWithError("ECONNREFUSED");
    const r = await checkServerPing({
      tenantUrl: "https://prod.id.forgerock.io",
      clientId: "c", clientSecret: "s"
    });
    expect(r.ok).toBe(false);
  });
});
