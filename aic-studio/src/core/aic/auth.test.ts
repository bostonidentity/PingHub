// src/core/aic/auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { fetchAccessToken } from "./auth";

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("fetchAccessToken", () => {
  it("POSTs client_credentials to the token endpoint and returns the token", async () => {
    const scope = nock("https://prod.id.forgerock.io")
      .post(
        "/am/oauth2/realms/root/access_token",
        "grant_type=client_credentials&client_id=svc-client&client_secret=hunter2&scope=fr%3Aam%3A*"
      )
      .reply(200, {
        access_token: "abc-123",
        token_type: "Bearer",
        expires_in: 3599,
        scope: "fr:am:*"
      });

    const result = await fetchAccessToken({
      tenantUrl: "https://prod.id.forgerock.io",
      clientId: "svc-client",
      clientSecret: "hunter2"
    });

    expect(result.accessToken).toBe("abc-123");
    expect(result.expiresInSeconds).toBe(3599);
    expect(scope.isDone()).toBe(true);
  });

  it("throws when AIC returns 401", async () => {
    nock("https://prod.id.forgerock.io")
      .post("/am/oauth2/realms/root/access_token")
      .reply(401, { error: "invalid_client" });

    await expect(
      fetchAccessToken({
        tenantUrl: "https://prod.id.forgerock.io",
        clientId: "wrong",
        clientSecret: "wrong"
      })
    ).rejects.toThrow(/401|invalid_client/i);
  });
});
