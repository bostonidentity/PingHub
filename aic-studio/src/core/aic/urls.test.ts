import { describe, it, expect } from "vitest";
import { tokenUrl, journeysListUrl, journeyDetailUrl, realmsListUrl } from "./urls";

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
