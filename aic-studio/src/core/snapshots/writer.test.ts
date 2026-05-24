import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJourney } from "./writer";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "snap-writer-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("writeJourney", () => {
  it("writes pretty-printed JSON to the journey file path", () => {
    const snapDir = join(root, "2026-05-24T15-30-00Z");
    writeJourney(snapDir, "alpha", "Login", { _id: "Login", nodes: { a: 1 } });
    const p = join(snapDir, "alpha", "journeys", "Login.json");
    expect(existsSync(p)).toBe(true);
    const text = readFileSync(p, "utf8");
    expect(JSON.parse(text)).toEqual({ _id: "Login", nodes: { a: 1 } });
    expect(text.includes("\n  ")).toBe(true);
  });

  it("creates intermediate directories", () => {
    const snapDir = join(root, "x", "y", "z");
    writeJourney(snapDir, "alpha", "L", { _id: "L" });
    expect(existsSync(join(snapDir, "alpha", "journeys", "L.json"))).toBe(true);
  });
});

import { writeFederation } from "./writer";
import { federationFile } from "./paths";

it("writeFederation writes JSON to realm/federation/<type>/<id>.json", () => {
  const snapDir = join(root, "2026-05-24T15-30-00Z");
  writeFederation(snapDir, "alpha", "saml2", "sp-acme", { _id: "sp-acme", x: 1 });
  expect(existsSync(federationFile(snapDir, "alpha", "saml2", "sp-acme"))).toBe(true);
});
