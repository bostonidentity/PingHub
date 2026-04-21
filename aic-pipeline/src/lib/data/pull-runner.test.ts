import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runPull } from "./pull-runner";
import { createRegistry } from "./job-registry";

let tmpDir: string;
let registry: ReturnType<typeof createRegistry>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pullrun-"));
  registry = createRegistry(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockFetchSequence(responses: { status: number; body: unknown }[]) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  });
}

const ENV_VARS = { TENANT_BASE_URL: "https://t.example", SERVICE_ACCOUNT_ID: "sa", SERVICE_ACCOUNT_KEY: "{}" };

describe("runPull: happy path", () => {
  it("fetches paginated records and writes one JSON per record atomically", async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, body: {
        result: [{ _id: "u1", userName: "a" }, { _id: "u2", userName: "b" }],
        pagedResultsCookie: "c1",
        totalPagedResults: 3,
      }},
      { status: 200, body: {
        result: [{ _id: "u3", userName: "c" }],
        pagedResultsCookie: null,
        totalPagedResults: 3,
      }},
    ]);

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job,
      registry,
      envsRoot: tmpDir,
      envVars: ENV_VARS,
      mintToken: async () => "tok",
      fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    expect(fs.readdirSync(typeDir).sort()).toEqual([
      "_manifest.json", "u1.json", "u2.json", "u3.json",
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(typeDir, "_manifest.json"), "utf-8"));
    expect(manifest.count).toBe(3);

    const after = registry.getJob(job.id)!;
    expect(after.status).toBe("completed");
    expect(after.progress[0]).toMatchObject({ status: "done", fetched: 3 });
  });
});

describe("runPull: auth refresh on 401", () => {
  it("re-mints token once on 401 and retries the page", async () => {
    const fetchMock = mockFetchSequence([
      { status: 401, body: {} },
      { status: 200, body: { result: [{ _id: "u1" }], pagedResultsCookie: null, totalPagedResults: 1 } },
    ]);
    const mintToken = vi.fn()
      .mockResolvedValueOnce("tok1")
      .mockResolvedValueOnce("tok2");

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken, fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(registry.getJob(job.id)?.status).toBe("completed");
  });
});

describe("runPull: transient 5xx retries, then fails", () => {
  it("retries up to MAX_RETRIES then marks type failed", async () => {
    const fetchMock = mockFetchSequence([
      { status: 500, body: {} },
      { status: 502, body: {} },
      { status: 503, body: {} },
    ]);

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
      retryDelayMs: 0,
    });

    expect(registry.getJob(job.id)?.status).toBe("failed");
    expect(registry.getJob(job.id)?.progress[0].status).toBe("failed");
  });
});

describe("runPull: abort mid-pull", () => {
  it("stops between pages and cleans up .pulling dir", async () => {
    const ctl = new AbortController();
    const fetchMock = vi.fn(async () => {
      ctl.abort(); // abort after first page
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{ _id: "u1" }], pagedResultsCookie: "c1", totalPagedResults: 100 }),
      } as Response;
    });

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: ctl.signal,
    });

    expect(registry.getJob(job.id)?.status).toBe("aborted");
    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    expect(fs.existsSync(typeDir)).toBe(false);
    const pullingPrefix = path.join(tmpDir, "uat", "managed-data", `.pulling-${job.id}`);
    expect(fs.existsSync(pullingPrefix)).toBe(false);
  });
});

describe("runPull: preserves previous snapshot on failure", () => {
  it("keeps the old type dir intact when the new pull fails mid-type", async () => {
    // Seed a previous snapshot.
    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    fs.mkdirSync(typeDir, { recursive: true });
    fs.writeFileSync(path.join(typeDir, "old.json"), JSON.stringify({ _id: "old" }));
    fs.writeFileSync(
      path.join(typeDir, "_manifest.json"),
      JSON.stringify({ type: "alpha_user", pulledAt: 1, count: 1, jobId: "prev" }),
    );

    const fetchMock = mockFetchSequence([
      { status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} },
    ]);
    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
      retryDelayMs: 0,
    });

    expect(fs.readdirSync(typeDir).sort()).toEqual(["_manifest.json", "old.json"]);
  });
});

describe("runPull: preflight count", () => {
  it("seeds progress.total from preflightCount before paginating", async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, body: {
        result: [{ _id: "u1" }, { _id: "u2" }],
        pagedResultsCookie: null,
      }},
    ]);

    const job = registry.startJob("uat", ["alpha_user"]);
    // Assert that preflight runs before pagination by checking progress total
    // arrives non-null, and by spying that preflightCount is invoked.
    const preflightSpy = vi.fn(async () => 42);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: preflightSpy,
      signal: new AbortController().signal,
    });

    expect(preflightSpy).toHaveBeenCalledWith("alpha_user", "tok");
    const after = registry.getJob(job.id)!;
    expect(after.status).toBe("completed");
    expect(after.progress[0].total).toBe(42);
    expect(after.progress[0].fetched).toBe(2);
  });

  it("leaves total null when preflight returns null", async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, body: {
        result: [{ _id: "u1" }],
        pagedResultsCookie: null,
      }},
    ]);
    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });
    const after = registry.getJob(job.id)!;
    expect(after.status).toBe("completed");
    expect(after.progress[0].total).toBeNull();
  });
});
