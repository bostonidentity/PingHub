import { describe, it, expect } from "vitest";
import { buildInspectWindow, INSPECT_WINDOW_HOURS, singleWindowTooWide } from "./journey-inspect";

describe("buildInspectWindow", () => {
  it("clamps a long range to its most-recent 24h", () => {
    const w = buildInspectWindow("2026-05-10T00:00:00.000Z", "2026-06-08T00:00:00.000Z");
    expect(w.to).toBe("2026-06-08T00:00:00.000Z");
    expect(w.from).toBe("2026-06-07T00:00:00.000Z"); // to − 24h
  });

  it("leaves a sub-24h range unchanged", () => {
    const w = buildInspectWindow("2026-06-07T06:00:00.000Z", "2026-06-07T12:00:00.000Z");
    expect(w).toEqual({ from: "2026-06-07T06:00:00.000Z", to: "2026-06-07T12:00:00.000Z" });
  });

  it("keeps an exactly-24h range whole", () => {
    const w = buildInspectWindow("2026-06-07T00:00:00.000Z", "2026-06-08T00:00:00.000Z");
    expect(w.from).toBe("2026-06-07T00:00:00.000Z");
  });

  it("echoes a degenerate range (to <= from) so the caller still gets something runnable", () => {
    const same = buildInspectWindow("2026-06-08T00:00:00.000Z", "2026-06-08T00:00:00.000Z");
    expect(same).toEqual({ from: "2026-06-08T00:00:00.000Z", to: "2026-06-08T00:00:00.000Z" });
  });

  it("echoes unparseable inputs", () => {
    expect(buildInspectWindow("nope", "also-nope")).toEqual({ from: "nope", to: "also-nope" });
  });

  it("exposes the window size", () => {
    expect(INSPECT_WINDOW_HOURS).toBe(24);
  });
});

describe("singleWindowTooWide", () => {
  it("flags a single-window (split 0) run wider than a day", () => {
    const msg = singleWindowTooWide("2026-05-09T20:51:00Z", "2026-06-08T20:51:00Z", 0);
    expect(msg).toMatch(/single AIC query/i);
    expect(msg).toMatch(/Window split/i);
  });

  it("allows a single-window run within a day", () => {
    expect(singleWindowTooWide("2026-06-07T20:51:00Z", "2026-06-08T20:51:00Z", 0)).toBeNull();
  });

  it("allows a wide range when windows are split (chunked handles it)", () => {
    expect(singleWindowTooWide("2026-05-09T20:51:00Z", "2026-06-08T20:51:00Z", 24)).toBeNull();
  });

  it("ignores degenerate/unparseable ranges (other validation handles those)", () => {
    expect(singleWindowTooWide("nope", "also", 0)).toBeNull();
    expect(singleWindowTooWide("2026-06-08T00:00:00Z", "2026-06-08T00:00:00Z", 0)).toBeNull();
  });
});
