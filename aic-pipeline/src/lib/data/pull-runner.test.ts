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
      {
        status: 200, body: {
          result: [{ _id: "u1", userName: "a" }, { _id: "u2", userName: "b" }],
          pagedResultsCookie: "c1",
          totalPagedResults: 3,
        }
      },
      {
        status: 200, body: {
          result: [{ _id: "u3", userName: "c" }],
          pagedResultsCookie: null,
          totalPagedResults: 3,
        }
      },
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
      "_index.json", "_manifest.json", "_offsets.json", "_refs.json", "data.ndjson",
    ]);

    const ndjson = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8");
    const lines = ndjson.split("\n").filter((l) => l.length > 0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { _id: "u1", userName: "a" },
      { _id: "u2", userName: "b" },
      { _id: "u3", userName: "c" },
    ]);

    const offsets = JSON.parse(fs.readFileSync(path.join(typeDir, "_offsets.json"), "utf-8"));
    expect(Object.keys(offsets).sort()).toEqual(["u1", "u2", "u3"]);
    // Sanity-check one offset by seeking and reading the line.
    const fd = fs.openSync(path.join(typeDir, "data.ndjson"), "r");
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, offsets.u2);
    fs.closeSync(fd);
    const u2Line = buf.toString("utf-8").split("\n")[0];
    expect(JSON.parse(u2Line)).toEqual({ _id: "u2", userName: "b" });

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

describe("runPull: page size", () => {
  it("uses opts.pageSize in the _pageSize query param", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{ _id: "u1" }], pagedResultsCookie: null, totalPagedResults: 1 }),
      } as Response;
    });

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
      pageSize: 7777,
    });

    const pageRequests = seenUrls.filter((u) => u.includes("_pageSize="));
    expect(pageRequests.length).toBeGreaterThan(0);
    for (const u of pageRequests) {
      expect(u).toContain("_pageSize=7777");
    }
  });

  it("defaults to 5000 when pageSize is not provided", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return {
        ok: true, status: 200,
        json: async () => ({ result: [{ _id: "u1" }], pagedResultsCookie: null, totalPagedResults: 1 }),
      } as Response;
    });

    const job = registry.startJob("uat", ["alpha_user"]);
    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    const pageRequests = seenUrls.filter((u) => u.includes("_pageSize="));
    for (const u of pageRequests) {
      expect(u).toContain("_pageSize=5000");
    }
  });
});

describe("runPull: preflight count", () => {
  it("seeds progress.total from preflightCount before paginating", async () => {
    const fetchMock = mockFetchSequence([
      {
        status: 200, body: {
          result: [{ _id: "u1" }, { _id: "u2" }],
          pagedResultsCookie: null,
        }
      },
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
      {
        status: 200, body: {
          result: [{ _id: "u1" }],
          pagedResultsCookie: null,
        }
      },
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

describe("runPull: cookie persistence", () => {
  it("persists cookie + byteLength on registry after each page", async () => {
    const fetchMock = mockFetchSequence([
      {
        status: 200, body: {
          result: [{ _id: "u1" }, { _id: "u2" }],
          pagedResultsCookie: "page2",
        }
      },
      {
        status: 200, body: {
          result: [{ _id: "u3" }],
          pagedResultsCookie: null,
        }
      },
    ]);

    const job = registry.startJob("uat", ["alpha_user"]);
    const updates: Array<{ cookie?: string | null; byteLength?: number; fetched?: number }> = [];
    const origUpdate = registry.updateProgress.bind(registry);
    registry.updateProgress = (id, type, patch) => {
      if ("cookie" in patch || "byteLength" in patch || "fetched" in patch) {
        updates.push({ ...patch });
      }
      origUpdate(id, type, patch);
    };

    await runPull({
      job, registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    // After page 1 we should have seen cookie="page2" with a positive byteLength.
    const afterPage1 = updates.find((u) => u.cookie === "page2");
    expect(afterPage1).toBeDefined();
    expect(afterPage1!.byteLength).toBeGreaterThan(0);

    // After the final page we should have seen cookie=null (last page reached).
    const afterFinal = updates.find((u) => u.cookie === null);
    expect(afterFinal).toBeDefined();
  });
});

describe("runPull: resume from cookie", () => {
  it("truncates half-written tail, rebuilds in-memory state, and continues from the persisted cookie", async () => {
    // Pre-state: a previous run wrote 2 pages + a half-written third record,
    // then crashed before the third record's offset was persisted.
    const typeStagingDir = path.join(tmpDir, "uat", "managed-data");
    const job = registry.startJob("uat", ["alpha_user"]);
    const pullingDir = path.join(typeStagingDir, `.pulling-${job.id}`, "alpha_user");
    fs.mkdirSync(pullingDir, { recursive: true });

    // Page 1: u1, u2. Page 2: u3, u4. Half-line: '{"_id":"u5...'.
    const page1 = `${JSON.stringify({ _id: "u1" })}\n${JSON.stringify({ _id: "u2" })}\n`;
    const page2 = `${JSON.stringify({ _id: "u3" })}\n${JSON.stringify({ _id: "u4" })}\n`;
    const halfLine = `{"_id":"u5"`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1 + page2 + halfLine);

    const byteAfterPage2 = Buffer.byteLength(page1 + page2, "utf-8");

    // Mark job interrupted with persisted cookie + byteLength matching end-of-page-2.
    registry.updateProgress(job.id, "alpha_user", {
      status: "running",
      fetched: 4,
      cookie: "page3",
      byteLength: byteAfterPage2,
    });
    registry.setJobStatus(job.id, "interrupted");

    // Resume: tenant returns one final page with u5 + u6, then null.
    const fetchMock = mockFetchSequence([
      {
        status: 200, body: {
          result: [{ _id: "u5" }, { _id: "u6" }],
          pagedResultsCookie: null,
        }
      },
    ]);

    await runPull({
      job: registry.getJob(job.id)!,
      registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    expect(fs.existsSync(typeDir)).toBe(true);
    const lines = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((r) => r._id)).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);

    const offsets = JSON.parse(fs.readFileSync(path.join(typeDir, "_offsets.json"), "utf-8"));
    expect(Object.keys(offsets).sort()).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);

    expect(registry.getJob(job.id)?.status).toBe("completed");
  });

  it("dedupes a duplicated page when registry persisted cookie but the next fetch returns the same records", async () => {
    const job = registry.startJob("uat", ["alpha_user"]);
    const pullingDir = path.join(tmpDir, "uat", "managed-data", `.pulling-${job.id}`, "alpha_user");
    fs.mkdirSync(pullingDir, { recursive: true });

    const page1 = `${JSON.stringify({ _id: "u1" })}\n${JSON.stringify({ _id: "u2" })}\n`;
    fs.writeFileSync(path.join(pullingDir, "data.ndjson"), page1);
    const byteAfterPage1 = Buffer.byteLength(page1, "utf-8");

    registry.updateProgress(job.id, "alpha_user", {
      status: "running",
      fetched: 2,
      cookie: "page1-cookie",
      byteLength: byteAfterPage1,
    });
    registry.setJobStatus(job.id, "interrupted");

    // Tenant returns the same u1, u2 again, then a fresh u3, then end.
    const fetchMock = mockFetchSequence([
      {
        status: 200, body: {
          result: [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }],
          pagedResultsCookie: null,
        }
      },
    ]);

    await runPull({
      job: registry.getJob(job.id)!,
      registry, envsRoot: tmpDir, envVars: ENV_VARS,
      mintToken: async () => "tok", fetchFn: fetchMock,
      preflightCount: async () => null,
      signal: new AbortController().signal,
    });

    const typeDir = path.join(tmpDir, "uat", "managed-data", "alpha_user");
    const lines = fs.readFileSync(path.join(typeDir, "data.ndjson"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((r) => r._id)).toEqual(["u1", "u2", "u3"]);
  });
});
