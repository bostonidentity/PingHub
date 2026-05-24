import { describe, it, expect } from "vitest";
import { tokenUrl, journeysListUrl, journeyDetailUrl, realmsListUrl, samlProvidersListUrl, samlProviderDetailUrl, oidcClientsListUrl, oidcClientDetailUrl, logsQueryUrl } from "./urls";

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

describe("Logs URL builder", () => {
  const base = "https://prod.id.forgerock.io";

  it("logsQueryUrl includes source and default pageSize=100", () => {
    expect(logsQueryUrl(base, { source: "am-everything" })).toBe(
      "https://prod.id.forgerock.io/monitoring/logs?source=am-everything&_pageSize=100"
    );
  });

  it("logsQueryUrl includes filterExpr when provided", () => {
    const url = logsQueryUrl(base, {
      source: "am-everything",
      filterExpr: `eventName eq "AM-LOGIN-FAILED"`
    });
    expect(url).toContain("source=am-everything");
    expect(url).toContain("_pageSize=100");
    // URLSearchParams URL-encodes spaces as +, quotes as %22
    expect(url).toContain("_queryFilter=eventName+eq+%22AM-LOGIN-FAILED%22");
  });

  it("logsQueryUrl includes beginTime + endTime when provided", () => {
    const url = logsQueryUrl(base, {
      source: "am",
      beginTime: "2026-05-24T00:00:00Z",
      endTime: "2026-05-24T23:59:59Z",
      pageSize: 500
    });
    expect(url).toContain("_pageSize=500");
    expect(url).toContain("beginTime=2026-05-24T00%3A00%3A00Z");
    expect(url).toContain("endTime=2026-05-24T23%3A59%3A59Z");
  });

  it("logsQueryUrl strips trailing slash on base", () => {
    expect(logsQueryUrl("https://prod.id.forgerock.io/", { source: "am" })).toBe(
      "https://prod.id.forgerock.io/monitoring/logs?source=am&_pageSize=100"
    );
  });
});
