// src/core/aic/federation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import {
  listSamlProviders, fetchSamlProvider, putSamlProvider,
  listOidcClients, fetchOidcClient, putOidcClient
} from "./federation";

const cache = { get: async () => "t", invalidate: () => {} };
const tenant = "https://prod.id.forgerock.io";

beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

describe("SAML2 providers", () => {
  it("listSamlProviders returns provider ids", async () => {
    nock(tenant).get(/entityproviders\/saml2\?_queryFilter=true/).reply(200, {
      result: [{ _id: "sp-acme" }, { _id: "idp-okta" }], resultCount: 2
    });
    expect(await listSamlProviders(tenant, "alpha", cache)).toEqual(["sp-acme", "idp-okta"]);
  });

  it("fetchSamlProvider returns full body", async () => {
    nock(tenant).get(/entityproviders\/saml2\/sp-acme$/).reply(200, { _id: "sp-acme", entityID: "acme.example.com" });
    const r = await fetchSamlProvider(tenant, "alpha", "sp-acme", cache);
    expect(r._id).toBe("sp-acme");
  });

  it("putSamlProvider PUTs body", async () => {
    nock(tenant).put(/entityproviders\/saml2\/sp-acme$/, { _id: "sp-acme", x: 1 }).reply(200, { _id: "sp-acme", _rev: "2" });
    const r = await putSamlProvider(tenant, "alpha", "sp-acme", { _id: "sp-acme", x: 1 }, cache);
    expect(r._rev).toBe("2");
  });
});

describe("OIDC clients", () => {
  it("listOidcClients returns client ids", async () => {
    nock(tenant).get(/agents\/OAuth2Client\?_queryFilter=true/).reply(200, {
      result: [{ _id: "client-a" }], resultCount: 1
    });
    expect(await listOidcClients(tenant, "alpha", cache)).toEqual(["client-a"]);
  });

  it("fetchOidcClient returns full body", async () => {
    nock(tenant).get(/agents\/OAuth2Client\/client-a$/).reply(200, { _id: "client-a", redirectionUris: ["x"] });
    const r = await fetchOidcClient(tenant, "alpha", "client-a", cache);
    expect(r._id).toBe("client-a");
  });

  it("putOidcClient PUTs body", async () => {
    nock(tenant).put(/agents\/OAuth2Client\/client-a$/, { _id: "client-a" }).reply(200, { _id: "client-a", _rev: "2" });
    const r = await putOidcClient(tenant, "alpha", "client-a", { _id: "client-a" }, cache);
    expect(r._rev).toBe("2");
  });
});
