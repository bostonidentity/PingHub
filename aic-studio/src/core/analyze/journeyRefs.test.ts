// src/core/analyze/journeyRefs.test.ts
import { describe, it, expect } from "vitest";
import { extractRefs } from "./journeyRefs";

describe("extractRefs", () => {
  it("returns [] for a journey with no script/inner-tree references", () => {
    const journey = {
      _id: "Login",
      entryNodeId: "start",
      nodes: {
        "node-1": { _id: "node-1", _type: { _id: "UsernameCollectorNode" }, displayName: "Username" }
      }
    };
    const refs = extractRefs({ realm: "alpha", journeyId: "Login", body: journey });
    expect(refs).toEqual([]);
  });

  it("finds script references on ScriptedDecisionNode nodes", () => {
    const journey = {
      _id: "Login",
      entryNodeId: "start",
      nodes: {
        "n1": { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "validateUser" },
        "n2": { _id: "n2", _type: { _id: "ScriptedDecisionNode" }, script: "enrichClaims" }
      }
    };
    const refs = extractRefs({ realm: "alpha", journeyId: "Login", body: journey });
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.target.id).sort()).toEqual(["enrichClaims", "validateUser"]);
    expect(refs[0].source.id).toBe("Login");
    expect(refs[0].source.resourceType).toBe("journey");
    expect(refs[0].target.resourceType).toBe("script");
    expect(refs[0].detail).toContain("n1");
  });

  it("finds inner-tree references on InnerTreeEvaluatorNode nodes", () => {
    const journey = {
      _id: "Outer",
      entryNodeId: "start",
      nodes: {
        "n1": { _id: "n1", _type: { _id: "InnerTreeEvaluatorNode" }, tree: "MfaJourney" }
      }
    };
    const refs = extractRefs({ realm: "alpha", journeyId: "Outer", body: journey });
    expect(refs).toHaveLength(1);
    expect(refs[0].target.resourceType).toBe("journey");
    expect(refs[0].target.id).toBe("MfaJourney");
  });

  it("finds SAML2 references on Saml2Node nodes", () => {
    const journey = {
      _id: "FederateOut",
      entryNodeId: "start",
      nodes: {
        "n1": { _id: "n1", _type: { _id: "Saml2Node" }, metaAlias: "/alpha/sp-acme", idpEntityId: "idp-okta" }
      }
    };
    const refs = extractRefs({ realm: "alpha", journeyId: "FederateOut", body: journey });
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.target.resourceType === "saml2")).toBe(true);
  });

  it("finds OAuth2Client references on OAuth2/social IdP nodes", () => {
    const journey = {
      _id: "SocialLogin",
      entryNodeId: "start",
      nodes: {
        "n1": { _id: "n1", _type: { _id: "SocialProviderHandlerNode" }, clientId: "google-client" }
      }
    };
    const refs = extractRefs({ realm: "alpha", journeyId: "SocialLogin", body: journey });
    expect(refs.some((r) => r.target.resourceType === "OAuth2Client" && r.target.id === "google-client")).toBe(true);
  });

  it("handles non-object journey body without throwing", () => {
    expect(extractRefs({ realm: "alpha", journeyId: "X", body: {} })).toEqual([]);
    expect(extractRefs({ realm: "alpha", journeyId: "X", body: { nodes: null } as unknown as Record<string, unknown> })).toEqual([]);
  });
});
