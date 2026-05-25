import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rest = require("../../src/vendor/fr-config-manager/common/restClient.js") as {
  restGet: (url: string, params: Record<string, unknown> | null, token: string) => Promise<{ status: number; data: unknown }>;
  restPut: (url: string, data: unknown, token: string, apiVersion?: string, ifMatch?: string, ifNoneMatch?: string) => Promise<{ status: number; data: unknown }>;
  restUpsert: (url: string, data: unknown, token: string, apiVersion?: string) => Promise<{ status: number; data: unknown }>;
  restPost: (url: string, dataOrParams: unknown, dataOrToken: unknown, tokenOrApiVersion?: unknown, maybeApiVersion?: string) => Promise<{ status: number; data: unknown }>;
  restDelete: (url: string, token: string, apiVersion?: string) => Promise<{ status: number; data: unknown }>;
};

const BASE = "https://tenant.example";

beforeEach(() => {
  nock.cleanAll();
});
afterEach(() => {
  nock.cleanAll();
});

describe("restGet", () => {
  it("sends Authorization bearer + query params", async () => {
    nock(BASE)
      .get("/x")
      .query({ _queryFilter: "true" })
      .matchHeader("authorization", "Bearer abc")
      .reply(200, { ok: true });

    const res = await rest.restGet(`${BASE}/x`, { _queryFilter: "true" }, "abc");
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });
});

describe("restPut", () => {
  it("sends the body + If-Match when provided", async () => {
    nock(BASE)
      .put("/obj", { a: 1 })
      .matchHeader("if-match", "*")
      .matchHeader("accept-api-version", "protocol=1.0,resource=1.0")
      .reply(200, { id: "obj" });

    const res = await rest.restPut(`${BASE}/obj`, { a: 1 }, "abc", "protocol=1.0,resource=1.0", "*");
    expect(res.status).toBe(200);
  });
});

describe("restUpsert", () => {
  it("does PUT with If-Match:* when GET succeeds (update path)", async () => {
    nock(BASE)
      .get("/obj")
      .reply(200, { existing: true });
    nock(BASE)
      .put("/obj", { a: 1 })
      .matchHeader("if-match", "*")
      .reply(200, { updated: true });

    const res = await rest.restUpsert(`${BASE}/obj`, { a: 1 }, "abc", "protocol=1.0,resource=1.0");
    expect(res.data).toEqual({ updated: true });
  });

  it("does PUT with If-None-Match:* when GET 404s (create path)", async () => {
    nock(BASE)
      .get("/obj")
      .reply(404);
    nock(BASE)
      .put("/obj", { a: 1 })
      .matchHeader("if-none-match", "*")
      .reply(201, { created: true });

    const res = await rest.restUpsert(`${BASE}/obj`, { a: 1 }, "abc");
    expect(res.data).toEqual({ created: true });
  });
});

describe("httpRequest retries", () => {
  it("retries twice on 500, then surfaces the error", async () => {
    nock(BASE).get("/flaky").times(3).reply(500, "boom");

    await expect(rest.restGet(`${BASE}/flaky`, null, "t")).rejects.toThrow();
    expect(nock.pendingMocks()).toEqual([]);
  });

  it("succeeds on a later attempt if earlier 5xx clears", async () => {
    nock(BASE).get("/flaky").reply(500);
    nock(BASE).get("/flaky").reply(200, { ok: true });

    const res = await rest.restGet(`${BASE}/flaky`, null, "t");
    expect(res.data).toEqual({ ok: true });
  });

  it("does NOT retry on 404", async () => {
    nock(BASE).get("/missing").reply(404);

    await expect(rest.restGet(`${BASE}/missing`, null, "t")).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});

describe("restPost (5-arg form)", () => {
  it("sends query params when called as (url, params, data, token, apiVersion)", async () => {
    nock(BASE)
      .post("/svc", () => true)
      .query({ _action: "nextdescendents" })
      .matchHeader("accept-api-version", "protocol=1.0,resource=1.0")
      .reply(200, { result: [] });

    const res = await rest.restPost(
      `${BASE}/svc`,
      { _action: "nextdescendents" },
      null,
      "tok",
      "protocol=1.0,resource=1.0",
    );
    expect(res.status).toBe(200);
  });

  it("supports the 4-arg form (url, data, token, apiVersion)", async () => {
    nock(BASE)
      .post("/create", { hello: "world" })
      .reply(200, { ok: true });

    const res = await rest.restPost(`${BASE}/create`, { hello: "world" }, "tok", "protocol=1.0,resource=1.0");
    expect(res.status).toBe(200);
  });
});

describe("restDelete", () => {
  it("sends a DELETE with optional Accept-Api-Version", async () => {
    nock(BASE)
      .delete("/gone")
      .matchHeader("accept-api-version", "protocol=2.1,resource=1.0")
      .reply(204);

    const res = await rest.restDelete(`${BASE}/gone`, "tok", "protocol=2.1,resource=1.0");
    expect(res.status).toBe(204);
  });
});
