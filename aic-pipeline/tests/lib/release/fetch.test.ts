import { describe, it, expect } from "vitest";
import { fetchReleaseInfo, type ReleaseFetcher } from "@/lib/release/fetch";

describe("fetchReleaseInfo", () => {
  it("hits GET <tenant>/environment/release and returns parsed ReleaseInfo", async () => {
    let captured = "";
    const fetcher: ReleaseFetcher = async (url, opts) => {
      captured = url;
      expect(opts.method).toBe("GET");
      expect(opts.token).toBe("tok");
      return {
        status: 200,
        ok: true,
        body: {
          channel: "regular",
          currentVersion: "2026.03.02",
          nextUpgrade: "2026-05-05T02:00:00Z",
        },
      };
    };
    const info = await fetchReleaseInfo({ tenantUrl: "https://t.example.com", token: "tok", timeoutMs: 5000 }, fetcher);
    expect(captured).toBe("https://t.example.com/environment/release");
    expect(info).toEqual({
      channel: "regular",
      currentVersion: "2026.03.02",
      nextUpgrade: "2026-05-05T02:00:00Z",
    });
  });

  it("accepts 'rapid' channel too", async () => {
    const fetcher: ReleaseFetcher = async () => ({
      status: 200,
      ok: true,
      body: { channel: "rapid", currentVersion: "21182.9", nextUpgrade: null },
    });
    const info = await fetchReleaseInfo({ tenantUrl: "https://t.example.com", token: "t", timeoutMs: 5000 }, fetcher);
    expect(info.channel).toBe("rapid");
    expect(info.nextUpgrade).toBeNull();
  });

  it("throws on a non-2xx response including the status code", async () => {
    const fetcher: ReleaseFetcher = async () => ({ status: 401, ok: false });
    await expect(
      fetchReleaseInfo({ tenantUrl: "https://t.example.com", token: "t", timeoutMs: 5000 }, fetcher),
    ).rejects.toThrow(/401/);
  });

  it("throws a clear error when the response body is missing required fields", async () => {
    const fetcher: ReleaseFetcher = async () => ({ status: 200, ok: true, body: { foo: "bar" } });
    await expect(
      fetchReleaseInfo({ tenantUrl: "https://t.example.com", token: "t", timeoutMs: 5000 }, fetcher),
    ).rejects.toThrow(/unexpected|shape|channel|version/i);
  });

  it("coerces a missing nextUpgrade field to null", async () => {
    const fetcher: ReleaseFetcher = async () => ({
      status: 200,
      ok: true,
      body: { channel: "regular", currentVersion: "x" },
    });
    const info = await fetchReleaseInfo({ tenantUrl: "https://t.example.com", token: "t", timeoutMs: 5000 }, fetcher);
    expect(info.nextUpgrade).toBeNull();
  });
});
