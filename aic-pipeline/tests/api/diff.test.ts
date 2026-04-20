import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/fr-config", () => ({
  getEnvironments: () => ([
    { name: "dev", label: "dev", color: "blue", envFile: "dev.env" },
    { name: "prod", label: "prod", color: "red", envFile: "prod.env" },
  ]),
}));

import { POST } from "@/app/api/diff/route";
import type { CompareReport } from "@/lib/diff-types";

const REPORT: CompareReport = {
  source: { environment: "repo", mode: "local" },
  target: { environment: "dev", mode: "remote" },
  generatedAt: "2026-04-13T00:00:00Z",
  summary: { added: 0, removed: 0, modified: 0, unchanged: 0 },
  files: [
    { scope: "journeys", relativePath: "journeys/Login", status: "added" } as any,
    { scope: "journeys", relativePath: "journeys/MFA",   status: "modified" } as any,
    { scope: "scripts",  relativePath: "scripts/foo.js", status: "removed" } as any,
  ],
};

function ndjsonBody(lines: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(JSON.stringify(l) + "\n"));
      controller.close();
    },
  });
}

beforeEach(() => {
  (globalThis as any).fetch = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: object): Request {
  return new Request("http://localhost/api/diff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/diff", () => {
  it("returns 400 when target is missing", async () => {
    const res = await POST(post({ scopes: ["journeys"] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when target env is unknown", async () => {
    const res = await POST(post({ target: "does-not-exist", scopes: ["journeys"] }));
    expect(res.status).toBe(400);
  });

  it("returns DiffSummary[] on success", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(
        ndjsonBody([
          { type: "stdout", data: "pulling…", ts: 0 },
          { type: "report", data: JSON.stringify(REPORT), ts: 1 },
          { type: "exit", code: 0, ts: 2 },
        ]),
        { status: 200 }
      )
    );
    const res = await POST(post({ target: "dev", scopes: ["journeys", "scripts"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { scope: "journeys", added: 1, modified: 1, removed: 0 },
      { scope: "scripts",  added: 0, modified: 0, removed: 1 },
    ]);
  });

  it("returns 500 when compare fetch fails", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("boom", { status: 500 })
    );
    const res = await POST(post({ target: "dev", scopes: ["journeys"] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/compare/i);
  });

  it("returns 500 when stream never emits a report line", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(
        ndjsonBody([
          { type: "stdout", data: "pulling…", ts: 0 },
          { type: "exit", code: 0, ts: 1 },
        ]),
        { status: 200 }
      )
    );
    const res = await POST(post({ target: "dev", scopes: ["journeys"] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/report/i);
  });
});
