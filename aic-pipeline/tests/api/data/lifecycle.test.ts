// tests/api/data/lifecycle.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

vi.mock("@/lib/iga-api", () => ({
  getAccessToken: vi.fn(async () => "fake-token"),
}));

// Give global fetch a deterministic two-page response.
const pages = [
  // Preflight (_countPolicy=EXACT&_pageSize=1): returns just the count.
  { status: 200, body: { result: [], pagedResultsCookie: null, totalPagedResults: 3 } },
  { status: 200, body: {
    result: [{ _id: "u1", userName: "alice" }, { _id: "u2", userName: "bob" }],
    pagedResultsCookie: "c1", totalPagedResults: 3,
  }},
  { status: 200, body: {
    result: [{ _id: "u3", userName: "charlie" }],
    pagedResultsCookie: null, totalPagedResults: 3,
  }},
];
let fetchCall = 0;
const origFetch = globalThis.fetch;
const origCwd = process.cwd();
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-int-"));
  // Seed a minimal env with .env file.
  const envDir = path.join(tmpDir, "environments", "test-env");
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(
    path.join(envDir, ".env"),
    "TENANT_BASE_URL=https://t.example\nSERVICE_ACCOUNT_ID=sa\nSERVICE_ACCOUNT_KEY={}\n",
  );
  process.chdir(tmpDir);
  fetchCall = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = pages[Math.min(fetchCall, pages.length - 1)];
    fetchCall++;
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  process.chdir(origCwd);
  globalThis.fetch = origFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("data API lifecycle", () => {
  it("POST /pull → poll GET /jobs/:id → completes with records on disk", async () => {
    // Fresh-import routes so they pick up the new cwd and the getRegistry singleton reset.
    vi.resetModules();
    const { POST } = await import("@/app/api/data/pull/route");
    const jobsId = await import("@/app/api/data/jobs/[id]/route");

    const startReq = new NextRequest("http://localhost/api/data/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "test-env", types: ["alpha_user"] }),
    });
    const startRes = await POST(startReq);
    expect(startRes.status).toBe(202);
    const { jobId } = await startRes.json();
    expect(typeof jobId).toBe("string");

    // Poll until completed (bounded to avoid hangs).
    let status = "";
    for (let i = 0; i < 50 && status !== "completed" && status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const res = await jobsId.GET(
        new NextRequest(`http://localhost/api/data/jobs/${jobId}`),
        { params: Promise.resolve({ id: jobId }) },
      );
      const job = await res.json();
      status = job.status;
    }
    expect(status).toBe("completed");

    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "alpha_user");
    expect(fs.readdirSync(typeDir).sort()).toEqual([
      "_manifest.json", "u1.json", "u2.json", "u3.json",
    ]);
  });

  it("POST /pull returns 409 when an active job exists for the env", async () => {
    vi.resetModules();
    // Fetch that never completes the first page so the job stays running.
    globalThis.fetch = vi.fn(async () => new Promise(() => {})) as typeof fetch;
    const { POST } = await import("@/app/api/data/pull/route");

    const req1 = new NextRequest("http://localhost/api/data/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "test-env", types: ["alpha_user"] }),
    });
    const r1 = await POST(req1);
    expect(r1.status).toBe(202);

    const req2 = new NextRequest("http://localhost/api/data/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "test-env", types: ["alpha_role"] }),
    });
    const r2 = await POST(req2);
    expect(r2.status).toBe(409);
    const body = await r2.json();
    expect(typeof body.jobId).toBe("string");
  });
});
