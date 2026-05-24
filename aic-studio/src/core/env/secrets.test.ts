import { describe, it, expect, beforeEach } from "vitest";
import { secretKey, SECRET_KINDS, makeStorage, type SecretStore } from "./secrets";

describe("secretKey", () => {
  it("builds a namespaced key per (env, kind)", () => {
    expect(secretKey("prod-tenant", "password")).toBe("aic-studio:env:prod-tenant:password");
    expect(secretKey("stage", "client-secret")).toBe("aic-studio:env:stage:client-secret");
  });

  it("exposes all four supported kinds", () => {
    expect(SECRET_KINDS).toEqual(["password", "client-secret", "log-api-key", "log-api-secret"]);
  });
});

describe("makeStorage (with in-memory backing for tests)", () => {
  let backing: Map<string, string>;
  let store: SecretStore;

  beforeEach(() => {
    backing = new Map();
    store = makeStorage({
      get: async (k) => backing.get(k),
      store: async (k, v) => { backing.set(k, v); },
      delete: async (k) => { backing.delete(k); }
    });
  });

  it("round-trips a stored secret", async () => {
    await store.set("prod-tenant", "password", "hunter2");
    expect(await store.get("prod-tenant", "password")).toBe("hunter2");
  });

  it("returns undefined for unset secrets", async () => {
    expect(await store.get("prod-tenant", "password")).toBeUndefined();
  });

  it("deletes all secrets for an env", async () => {
    for (const kind of SECRET_KINDS) await store.set("prod-tenant", kind, "x");
    await store.deleteAll("prod-tenant");
    for (const kind of SECRET_KINDS) {
      expect(await store.get("prod-tenant", kind)).toBeUndefined();
    }
  });
});
