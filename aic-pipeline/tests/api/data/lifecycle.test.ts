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
  {
    status: 200, body: {
      result: [{ _id: "u1", userName: "alice" }, { _id: "u2", userName: "bob" }],
      pagedResultsCookie: "c1", totalPagedResults: 3,
    }
  },
  {
    status: 200, body: {
      result: [{ _id: "u3", userName: "charlie" }],
      pagedResultsCookie: null, totalPagedResults: 3,
    }
  },
];
let fetchCall = 0;
const origFetch = globalThis.fetch;
const origCwd = process.cwd();
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-int-"));
  // Point ENVIRONMENTS_DIR at our temp dir so paths.ts picks it up on re-import.
  process.env.PINGHUB_DATA_DIR = path.join(tmpDir, "environments");
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
  delete process.env.PINGHUB_DATA_DIR;
  globalThis.fetch = origFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Clear the globalThis registry singleton so it doesn't leak between tests.
  delete (globalThis as Record<string, unknown>).__dataJobRegistry;
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
    const entries = fs.readdirSync(typeDir).sort();
    // Filter SQLite WAL/SHM sidecars — present only if WAL hasn't checkpointed yet.
    const stable = entries.filter((e) => !e.endsWith("-wal") && !e.endsWith("-shm"));
    expect(stable).toEqual([
      "_manifest.json", "_refs.json", "data.ndjson", "index.sqlite",
    ]);
    expect(stable).not.toContain("_index.json");
    expect(stable).not.toContain("_offsets.json");
  });

  it("POST /pull returns 409 when an active job exists for the env", async () => {
    vi.resetModules();
    // Fetch that never completes the first page so the job stays running.
    globalThis.fetch = vi.fn(async () => new Promise(() => { })) as typeof fetch;
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

  it("POST /pull/jobs/:id/resume continues from persisted cookie", async () => {
    vi.resetModules();
    const { POST } = await import("@/app/api/data/pull/route");
    const resumeRoute = await import("@/app/api/data/pull/jobs/[jobId]/resume/route");
    const jobsId = await import("@/app/api/data/jobs/[id]/route");

    // Get the registry singleton and seed an interrupted job + on-disk state.
    const { getRegistry } = await import("@/lib/data/job-registry");
    const reg = getRegistry();
    const job = reg.startJob("test-env", ["alpha_user"]);

    const pullingDir = path.join(
      tmpDir, "environments", "test-env", "managed-data",
      `.pulling-${job.id}`, "alpha_user",
    );
    fs.mkdirSync(pullingDir, { recursive: true });
    const page1 = `${JSON.stringify({ _id: "u1", userName: "alice" })}\n${JSON.stringify({ _id: "u2", userName: "bob" })}\n`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1);
    reg.updateProgress(job.id, "alpha_user", {
      status: "running", fetched: 2,
      cookie: "page2-cookie",
      byteLength: Buffer.byteLength(page1, "utf-8"),
      total: 3,
    });
    reg.setJobStatus(job.id, "interrupted");

    // Reset fetch to return a final page and end.
    fetchCall = 0;
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ result: [{ _id: "u3", userName: "charlie" }], pagedResultsCookie: null }),
    } as Response)) as typeof fetch;

    const resumeReq = new NextRequest(
      `http://localhost/api/data/pull/jobs/${job.id}/resume`,
      { method: "POST" },
    );
    const resumeRes = await resumeRoute.POST(
      resumeReq,
      { params: Promise.resolve({ jobId: job.id }) },
    );
    expect(resumeRes.status).toBe(202);

    // Poll until completed.
    let status = "";
    for (let i = 0; i < 50 && status !== "completed" && status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const res = await jobsId.GET(
        new NextRequest(`http://localhost/api/data/jobs/${job.id}`),
        { params: Promise.resolve({ id: job.id }) },
      );
      status = (await res.json()).status;
    }
    expect(status).toBe("completed");

    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "alpha_user");
    const lines = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((r) => r._id)).toEqual(["u1", "u2", "u3"]);
  });

  it("POST /pull/jobs/:id/resume returns 409 if job is not interrupted", async () => {
    vi.resetModules();
    const resumeRoute = await import("@/app/api/data/pull/jobs/[jobId]/resume/route");
    const { getRegistry } = await import("@/lib/data/job-registry");
    const reg = getRegistry();
    const job = reg.startJob("test-env", ["alpha_user"]);
    reg.setJobStatus(job.id, "completed");

    const res = await resumeRoute.POST(
      new NextRequest(`http://localhost/api/data/pull/jobs/${job.id}/resume`, { method: "POST" }),
      { params: Promise.resolve({ jobId: job.id }) },
    );
    expect(res.status).toBe(409);
  });

  it("backfills index.sqlite for a pre-SQLite snapshot on first read", async () => {
    vi.resetModules();
    const recordsRoute = await import("@/app/api/data/records/[env]/[type]/route");

    // Simulate a pre-SQLite snapshot: data.ndjson + _manifest.json only.
    const typeDir = path.join(tmpDir, "environments", "test-env", "managed-data", "legacy_user");
    fs.mkdirSync(typeDir, { recursive: true });
    fs.writeFileSync(
      path.join(typeDir, "data.ndjson"),
      [
        JSON.stringify({ _id: "a", userName: "alice" }),
        JSON.stringify({ _id: "b", userName: "bob" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(typeDir, "_manifest.json"),
      JSON.stringify({ type: "legacy_user", pulledAt: Date.now(), count: 2, jobId: "seed" }),
    );

    const req = new NextRequest("http://localhost/api/data/records/test-env/legacy_user?q=&page=1&limit=10");
    const res = await recordsRoute.GET(
      req,
      { params: Promise.resolve({ env: "test-env", type: "legacy_user" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(2);
    expect(json.records.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
    expect(fs.existsSync(path.join(typeDir, "index.sqlite"))).toBe(true);
  });
});
