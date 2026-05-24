import { describe, it, expect } from "vitest";
import { tokenUrl, journeysListUrl, journeyDetailUrl, realmsListUrl, samlProvidersListUrl, samlProviderDetailUrl, oidcClientsListUrl, oidcClientDetailUrl } from "./urls";

describe("AIC URLs", () => {
  const base = "https://prod.id.forgerock.io";

  it("tokenUrl points to AM's root-realm token endpoint", () => {
    expect(tokenUrl(base)).toBe("https://prod.id.forgerock.io/am/oauth2/realms/root/access_token");
  });

  it("realmsListUrl lists realms under root", () => {
    expect(realmsListUrl(base)).toBe("https://prod.id.forgerock.io/am/json/global-config/realms?_queryFilter=true");
  });

  it("journeysListUrl uses _queryFilter=true with realm path", () => {
    expect(journeysListUrl(base, "alpha")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees?_queryFilter=true"
    );
  });

  it("journeyDetailUrl uses the tree id", () => {
    expect(journeyDetailUrl(base, "alpha", "Login")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/Login"
    );
  });

  it("strips trailing slash on base", () => {
    expect(tokenUrl("https://prod.id.forgerock.io/")).toBe(
      "https://prod.id.forgerock.io/am/oauth2/realms/root/access_token"
    );
  });
});

describe("Federation URLs", () => {
  const base = "https://prod.id.forgerock.io";

  it("samlProvidersListUrl uses _queryFilter=true", () => {
    expect(samlProvidersListUrl(base, "alpha")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/federation/entityproviders/saml2?_queryFilter=true"
    );
  });

  it("samlProviderDetailUrl uses entity id", () => {
    expect(samlProviderDetailUrl(base, "alpha", "sp-acme")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/federation/entityproviders/saml2/sp-acme"
    );
  });

  it("oidcClientsListUrl points at realm-config oauth2 clients", () => {
    expect(oidcClientsListUrl(base, "alpha")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/agents/OAuth2Client?_queryFilter=true"
    );
  });

  it("oidcClientDetailUrl uses agent id", () => {
    expect(oidcClientDetailUrl(base, "alpha", "my-client")).toBe(
      "https://prod.id.forgerock.io/am/json/realms/root/realms/alpha/realm-config/agents/OAuth2Client/my-client"
    );
  });
});
