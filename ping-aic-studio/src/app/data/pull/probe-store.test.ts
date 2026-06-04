// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { startProbe, getProbeState, loadProbes, probeKey, subscribeProbe } from "./probe-store";

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + "\n"));
      c.close();
    },
  });
}
const ev = (o: unknown) => JSON.stringify(o);
function mockFetch(lines: string[], ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, body: ok ? streamOf(lines) : null });
}

beforeEach(() => { localStorage.clear(); });

describe("startProbe", () => {
  it("streams events, persists counts to localStorage, and resets probing", async () => {
    vi.stubGlobal("fetch", mockFetch([
      ev({ event: "start", type: "alpha_user" }),
      ev({ event: "progress", type: "alpha_user", fetched: 500, pages: 1 }),
      ev({ event: "done", type: "alpha_user", count: 1200 }),
      ev({ event: "end" }),
    ]));
    const ok = await startProbe("prod", ["alpha_user"]);
    expect(ok).toBe(true);
    expect(loadProbes()[probeKey("prod", "alpha_user")]?.count).toBe(1200);
    const s = getProbeState();
    expect(s.probing).toBe(false);          // flags reset when done
    expect(s.currentlyProbing).toBeNull();
    expect(s.env).toBe("prod");
  });

  it("persists a null count with its reason (tenant declined to count)", async () => {
    vi.stubGlobal("fetch", mockFetch([
      ev({ event: "done", type: "team", count: null, reason: "no _countPolicy" }),
    ]));
    await startProbe("uat", ["team"]);
    const entry = loadProbes()[probeKey("uat", "team")];
    expect(entry?.count).toBeNull();
    expect(entry?.reason).toBe("no _countPolicy");
    expect(typeof entry?.probedAt).toBe("number");
  });

  it("surfaces a fatal event as an error and stops, probing reset", async () => {
    vi.stubGlobal("fetch", mockFetch([ev({ event: "fatal", error: "tenant down" })]));
    const ok = await startProbe("prod", ["x"]);
    expect(ok).toBe(false);
    expect(getProbeState().error).toBe("tenant down");
    expect(getProbeState().probing).toBe(false);
  });

  it("reports a non-OK HTTP response as an error", async () => {
    vi.stubGlobal("fetch", mockFetch([], false, 503));
    const ok = await startProbe("prod", ["x"]);
    expect(ok).toBe(false);
    expect(getProbeState().error).toContain("503");
  });

  it("no-ops with no env or no types (no fetch)", async () => {
    const f = mockFetch([]);
    vi.stubGlobal("fetch", f);
    expect(await startProbe("", ["x"])).toBe(true);
    expect(await startProbe("prod", [])).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("notifies subscribers as state changes", async () => {
    vi.stubGlobal("fetch", mockFetch([ev({ event: "done", type: "t", count: 1 })]));
    const fn = vi.fn();
    const unsub = subscribeProbe(fn);
    await startProbe("uat", ["t"]);
    expect(fn).toHaveBeenCalled();
    unsub();
  });
});
