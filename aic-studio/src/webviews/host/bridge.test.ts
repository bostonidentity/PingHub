// src/webviews/host/bridge.test.ts
import { describe, it, expect } from "vitest";
import {
  OpenRequestSchema, LoadResponseSchema, SaveRequestSchema, SaveResponseSchema,
  type OpenRequest, type LoadResponse, type SaveRequest, type SaveResponse
} from "./bridge";

describe("Bridge schemas", () => {
  it("OpenRequest parses a valid open message", () => {
    const m: OpenRequest = {
      kind: "open",
      envName: "prod",
      realm: "alpha",
      federationType: "saml2",
      id: "sp-acme"
    };
    expect(OpenRequestSchema.parse(m)).toEqual(m);
  });

  it("OpenRequest rejects missing fields", () => {
    expect(() => OpenRequestSchema.parse({ kind: "open" })).toThrow();
  });

  it("LoadResponse parses with body", () => {
    const m: LoadResponse = {
      kind: "load",
      envName: "prod",
      realm: "alpha",
      federationType: "saml2",
      id: "sp-acme",
      body: { _id: "sp-acme", entityID: "acme" }
    };
    expect(LoadResponseSchema.parse(m)).toEqual(m);
  });

  it("LoadResponse allows null body when snapshot missing", () => {
    const m: LoadResponse = {
      kind: "load",
      envName: "prod",
      realm: "alpha",
      federationType: "saml2",
      id: "sp-acme",
      body: null
    };
    expect(LoadResponseSchema.parse(m)).toEqual(m);
  });

  it("SaveRequest parses with body", () => {
    const m: SaveRequest = {
      kind: "save",
      envName: "prod",
      realm: "alpha",
      federationType: "saml2",
      id: "sp-acme",
      body: { _id: "sp-acme", x: 1 }
    };
    expect(SaveRequestSchema.parse(m)).toEqual(m);
  });

  it("SaveResponse parses success", () => {
    const m: SaveResponse = { kind: "save-result", ok: true };
    expect(SaveResponseSchema.parse(m)).toEqual(m);
  });

  it("SaveResponse parses failure with error", () => {
    const m: SaveResponse = { kind: "save-result", ok: false, error: "401 unauthorized" };
    expect(SaveResponseSchema.parse(m)).toEqual(m);
  });
});
