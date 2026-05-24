// src/core/monitors/tls.test.ts
import { describe, it, expect } from "vitest";
import { checkTls } from "./tls";

const ONLINE = process.env.TEST_NETWORK !== "0";

describe.skipIf(!ONLINE)("checkTls (network)", () => {
  it("returns ok=true with daysRemaining>0 for example.com", async () => {
    const r = await checkTls("example.com");
    expect(r.ok).toBe(true);
    expect(r.daysRemaining).toBeGreaterThan(0);
    expect(r.subject.length).toBeGreaterThan(0);
  });

  it("returns ok=false with error for unreachable host", async () => {
    const r = await checkTls("this.host.does.not.exist.invalid", 443, 2000);
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});

// Always-runnable structural test
describe("checkTls signature", () => {
  it("returns a Promise<TlsCheckResult>", () => {
    const p = checkTls("example.com", 443, 1);  // very short timeout → likely fails fast
    expect(typeof p.then).toBe("function");
  });
});
