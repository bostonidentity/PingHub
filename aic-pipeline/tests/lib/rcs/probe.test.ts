import { describe, it, expect } from "vitest";
import { probeConnector, probeAll, probeConnectorServers, type Fetcher } from "@/lib/rcs/probe";

describe("probeConnector", () => {
  it("returns ok with httpStatus when fetcher responds 2xx", async () => {
    const fetcher: Fetcher = async (url, opts) => {
      expect(url).toBe("https://t.example.com/openidm/system/ad-hr?_action=test");
      expect(opts.method).toBe("POST");
      expect(opts.token).toBe("tok");
      expect(opts.timeoutMs).toBe(5000);
      return { status: 200, ok: true };
    };
    const r = await probeConnector(
      { tenantUrl: "https://t.example.com", name: "ad-hr", token: "tok", timeoutMs: 5000 },
      fetcher,
    );
    expect(r.name).toBe("ad-hr");
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.error).toBeUndefined();
  });

  it("returns ok=false with error message when fetcher throws", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("ECONNABORTED: timeout");
    };
    const r = await probeConnector(
      { tenantUrl: "https://t.example.com", name: "ad-hr", token: "tok", timeoutMs: 5000 },
      fetcher,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNABORTED/);
    expect(r.httpStatus).toBeUndefined();
  });

  it("returns ok=false with status when fetcher returns a non-2xx response", async () => {
    const fetcher: Fetcher = async () => ({ status: 503, ok: false });
    const r = await probeConnector(
      { tenantUrl: "https://t.example.com", name: "x", token: "tok", timeoutMs: 5000 },
      fetcher,
    );
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(503);
    expect(r.error).toMatch(/HTTP 503/);
  });

  it("url-encodes the connector name", async () => {
    let captured = "";
    const fetcher: Fetcher = async (url) => {
      captured = url;
      return { status: 200, ok: true };
    };
    await probeConnector(
      { tenantUrl: "https://t.example.com", name: "weird name/with spaces", token: "t", timeoutMs: 5000 },
      fetcher,
    );
    expect(captured).toContain("weird%20name%2Fwith%20spaces");
  });
});

describe("probeAll", () => {
  it("probes every connector and returns results in input order", async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes("fail-me")) return { status: 500, ok: false };
      return { status: 200, ok: true };
    };
    const results = await probeAll({
      tenantUrl: "https://t.example.com",
      token: "t",
      timeoutMs: 5000,
      concurrency: 2,
      connectors: ["a", "b", "fail-me", "d"],
      fetcher,
    });
    expect(results.map((r) => r.name)).toEqual(["a", "b", "fail-me", "d"]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true]);
  });

  it("calls onResult as each probe finishes", async () => {
    const fetcher: Fetcher = async () => ({ status: 200, ok: true });
    const seen: string[] = [];
    await probeAll({
      tenantUrl: "https://t.example.com",
      token: "t",
      timeoutMs: 5000,
      concurrency: 2,
      connectors: ["a", "b"],
      fetcher,
      onResult: (r) => seen.push(r.name),
    });
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});

describe("probeConnectorServers", () => {
  it("hits /openidm/system?_action=testConnectorServers and parses openicf[] into a name→MemberStatus map", async () => {
    let captured = "";
    const fetcher: Fetcher = async (url) => {
      captured = url;
      return {
        status: 200,
        ok: true,
        body: {
          openicf: [
            { name: "rcs-ext-1", type: "remoteConnectorServer", ok: true },
            { name: "rcs-ext-2", type: "remoteConnectorServer", ok: false, error: "Connection failed: WAITING_TO_CONNECT" },
          ],
        },
      };
    };
    const result = await probeConnectorServers(
      { tenantUrl: "https://t.example.com", token: "tok", timeoutMs: 5000 },
      fetcher,
    );
    expect(captured).toBe("https://t.example.com/openidm/system?_action=testConnectorServers");
    expect(result["rcs-ext-1"]).toEqual({ name: "rcs-ext-1", ok: true, latencyMs: expect.any(Number) });
    expect(result["rcs-ext-2"].ok).toBe(false);
    expect(result["rcs-ext-2"].error).toMatch(/WAITING_TO_CONNECT/);
  });

  it("returns an empty map when the response body is missing the openicf array", async () => {
    const fetcher: Fetcher = async () => ({ status: 200, ok: true, body: {} });
    const r = await probeConnectorServers(
      { tenantUrl: "https://t.example.com", token: "tok", timeoutMs: 5000 },
      fetcher,
    );
    expect(r).toEqual({});
  });

  it("throws a meaningful error when the HTTP request fails", async () => {
    const fetcher: Fetcher = async () => ({ status: 403, ok: false });
    await expect(
      probeConnectorServers(
        { tenantUrl: "https://t.example.com", token: "tok", timeoutMs: 5000 },
        fetcher,
      ),
    ).rejects.toThrow(/HTTP 403/);
  });
});
