import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  listSamlProviders: vi.fn(),
  getSamlProvider: vi.fn(),
  realmsForEnvironment: vi.fn(),
}));

vi.mock("@/lib/federation/saml", () => ({
  listSamlProviders: mocks.listSamlProviders,
  getSamlProvider: mocks.getSamlProvider,
  realmsForEnvironment: mocks.realmsForEnvironment,
}));

import { GET as GET_PROVIDERS } from "@/app/api/federation/saml/providers/route";
import { GET as GET_PROVIDER } from "@/app/api/federation/saml/provider/route";
import { GET as GET_REALMS } from "@/app/api/federation/saml/realms/route";

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe("federation saml API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSamlProviders.mockResolvedValue([]);
    mocks.getSamlProvider.mockResolvedValue(null);
    mocks.realmsForEnvironment.mockReturnValue(["alpha"]);
  });

  it("returns realms for an environment", async () => {
    const res = await GET_REALMS(req("/api/federation/saml/realms?environment=sandbox"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ realms: ["alpha"] });
    expect(mocks.realmsForEnvironment).toHaveBeenCalledWith("sandbox");
  });

  it("lists providers with live source defaults", async () => {
    mocks.listSamlProviders.mockResolvedValue([{ id: "idp", entityId: "entity", location: "hosted" }]);
    const res = await GET_PROVIDERS(req("/api/federation/saml/providers?environment=sandbox&realm=alpha&query=aic"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [{ id: "idp", entityId: "entity", location: "hosted" }] });
    expect(mocks.listSamlProviders).toHaveBeenCalledWith({
      environment: "sandbox",
      realm: "alpha",
      query: "aic",
      source: "live",
      pageSize: 50,
    });
  });

  it("returns provider detail", async () => {
    mocks.getSamlProvider.mockResolvedValue({ id: "idp", entityId: "entity", location: "hosted", metadata: "<xml/>" });
    const res = await GET_PROVIDER(req("/api/federation/saml/provider?environment=sandbox&realm=alpha&location=hosted&id=idp&entityId=entity"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: { id: "idp", entityId: "entity", location: "hosted", metadata: "<xml/>" } });
  });

  it("validates required query params", async () => {
    expect((await GET_PROVIDERS(req("/api/federation/saml/providers"))).status).toBe(400);
    expect((await GET_PROVIDER(req("/api/federation/saml/provider?environment=sandbox&id=x"))).status).toBe(400);
    expect((await GET_REALMS(req("/api/federation/saml/realms"))).status).toBe(400);
  });
});
