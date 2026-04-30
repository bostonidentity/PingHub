import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { listSnapshotTypes, readRecord, listRecords, evictCache } from "./snapshot-fs";
import { buildIndexFromNDJson } from "./index-builder";

let tmpDir: string;
const ENV = "test-env";

function writeRecord(type: string, id: string, body: Record<string, unknown>) {
  const dir = path.join(tmpDir, ENV, "managed-data", type);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
}

function writeManifest(type: string, count: number, pulledAt = 1700000000000) {
  const dir = path.join(tmpDir, ENV, "managed-data", type);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_manifest.json"),
    JSON.stringify({ type, pulledAt, count, jobId: "j1" }),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-tab-"));
});

afterEach(() => {
  // Evict all cached entries so tests don't leak state.
  const managedDir = path.join(tmpDir, ENV, "managed-data");
  if (fs.existsSync(managedDir)) {
    for (const d of fs.readdirSync(managedDir)) {
      evictCache(path.join(managedDir, d));
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("listSnapshotTypes", () => {
  it("returns empty list when no snapshot directory exists", async () => {
    expect(await listSnapshotTypes(tmpDir, ENV)).toEqual([]);
  });

  it("lists types that have a manifest", async () => {
    writeManifest("alpha_user", 3, 1700000000000);
    writeManifest("alpha_role", 2, 1700000001000);
    const out = await listSnapshotTypes(tmpDir, ENV);
    expect(out).toEqual([
      { name: "alpha_role", count: 2, pulledAt: 1700000001000 },
      { name: "alpha_user", count: 3, pulledAt: 1700000000000 },
    ].sort((a, b) => a.name.localeCompare(b.name)));
  });

  it("skips directories without a manifest", async () => {
    writeManifest("alpha_user", 1);
    fs.mkdirSync(path.join(tmpDir, ENV, "managed-data", "half_pulled"), { recursive: true });
    const out = await listSnapshotTypes(tmpDir, ENV);
    expect(out.map((t) => t.name)).toEqual(["alpha_user"]);
  });
});

describe("readRecord", () => {
  it("reads a single record by id", async () => {
    writeRecord("alpha_user", "u1", { _id: "u1", userName: "alice" });
    expect(await readRecord(tmpDir, ENV, "alpha_user", "u1")).toEqual({
      _id: "u1",
      userName: "alice",
    });
  });

  it("returns null for missing record", async () => {
    expect(await readRecord(tmpDir, ENV, "alpha_user", "missing")).toBeNull();
  });
});

describe("listRecords", () => {
  beforeEach(async () => {
    writeManifest("alpha_user", 3);
    writeRecord("alpha_user", "u1", { _id: "u1", name: "alice", mail: "alice@x.co" });
    writeRecord("alpha_user", "u2", { _id: "u2", name: "bob", mail: "bob@x.co" });
    writeRecord("alpha_user", "u3", { _id: "u3", name: "charlie", mail: "alice@y.co" });
    const typeDir = path.join(tmpDir, ENV, "managed-data", "alpha_user");
    // Write data.ndjson so the SQLite backfill path can build the index.
    const records = [
      { _id: "u1", name: "alice", mail: "alice@x.co" },
      { _id: "u2", name: "bob", mail: "bob@x.co" },
      { _id: "u3", name: "charlie", mail: "alice@y.co" },
    ];
    fs.writeFileSync(
      path.join(typeDir, "data.ndjson"),
      records.map((r) => JSON.stringify(r) + "\n").join(""),
    );
    await buildIndexFromNDJson(typeDir, (rec) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k.startsWith("_") && k !== "_id") continue;
        if (typeof v === "string") out[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      }
      return out;
    });
  });

  it("returns all records paginated in pull order", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "",
      page: 1,
      limit: 10,
      display: { title: "name", searchFields: ["name"] },
    });
    expect(page.total).toBe(3);
    expect(page.records.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
    expect(page.records[0]).toEqual({ id: "u1", title: "alice" });
  });

  it("substring-search matches values across all indexed fields", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "alice",
      page: 1,
      limit: 10,
      display: { title: "name", searchFields: [] },
    });
    // u1 matches on both name and mail; u3 matches on mail only.
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });

  it("full-JSON search matches on values across all records", async () => {
    // "@x.co" appears in two records (alice and bob).
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "@x.co",
      page: 1,
      limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(2);
  });

  it("paginates with limit and page", async () => {
    const first = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 2,
      display: { title: "name", searchFields: [] },
    });
    expect(first.records.map((r) => r.id)).toEqual(["u1", "u2"]);
    const second = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 2, limit: 2,
      display: { title: "name", searchFields: [] },
    });
    expect(second.records.map((r) => r.id)).toEqual(["u3"]);
  });

  it("falls back to id when the title field is missing", async () => {
    writeRecord("alpha_user", "u4", { _id: "u4" });
    const typeDir = path.join(tmpDir, ENV, "managed-data", "alpha_user");
    fs.appendFileSync(path.join(typeDir, "data.ndjson"), JSON.stringify({ _id: "u4" }) + "\n");
    evictCache(typeDir);
    await buildIndexFromNDJson(typeDir, (rec) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k.startsWith("_") && k !== "_id") continue;
        if (typeof v === "string") out[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      }
      return out;
    });
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.records.find((r) => r.id === "u4")?.title).toBe("u4");
  });

  it("honors titleField override and matches case-insensitively", async () => {
    // Record uses capital-N Name; override asks for lower-case "name".
    writeRecord("alpha_user", "u5", { _id: "u5", Name: "Overridden" });
    const typeDir = path.join(tmpDir, ENV, "managed-data", "alpha_user");
    fs.appendFileSync(path.join(typeDir, "data.ndjson"), JSON.stringify({ _id: "u5", Name: "Overridden" }) + "\n");
    evictCache(typeDir);
    await buildIndexFromNDJson(typeDir, (rec) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k.startsWith("_") && k !== "_id") continue;
        if (typeof v === "string") out[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      }
      return out;
    });
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "_id", searchFields: [] },
      titleField: "name",
    });
    expect(page.records.find((r) => r.id === "u5")?.title).toBe("Overridden");
  });
});

// ── NDJSON-format reader tests ─────────────────────────────────────────────

async function writeNDJsonSnapshot(
  type: string,
  records: Record<string, unknown>[],
) {
  const dir = path.join(tmpDir, ENV, "managed-data", type);
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r) + "\n");
  fs.writeFileSync(path.join(dir, "data.ndjson"), lines.join(""));
  fs.writeFileSync(
    path.join(dir, "_manifest.json"),
    JSON.stringify({ type, pulledAt: 1700000000000, count: records.length, jobId: "j1" }),
  );
  await buildIndexFromNDJson(dir, (rec) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k.startsWith("_") && k !== "_id") continue;
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
    return out;
  });
}

describe("readRecord (NDJSON format)", () => {
  it("reads a record by id via byte-offset seek", async () => {
    await writeNDJsonSnapshot("alpha_user", [
      { _id: "u1", userName: "alice" },
      { _id: "u2", userName: "bob", longField: "x".repeat(500) },
      { _id: "u3", userName: "charlie" },
    ]);
    expect(await readRecord(tmpDir, ENV, "alpha_user", "u2"))
      .toEqual({ _id: "u2", userName: "bob", longField: "x".repeat(500) });
  });

  it("returns null for an unknown id in NDJSON format", async () => {
    await writeNDJsonSnapshot("alpha_user", [{ _id: "u1" }]);
    expect(await readRecord(tmpDir, ENV, "alpha_user", "missing")).toBeNull();
  });
});

// ── Index-accelerated path ─────────────────────────────────────────────────

describe("listRecords with SQLite index", () => {
  beforeEach(async () => {
    writeManifest("alpha_user", 3);
    writeRecord("alpha_user", "u1", { _id: "u1", name: "alice", mail: "alice@x.co" });
    writeRecord("alpha_user", "u2", { _id: "u2", name: "bob", mail: "bob@x.co" });
    writeRecord("alpha_user", "u3", { _id: "u3", name: "charlie", mail: "alice@y.co" });
    const typeDir = path.join(tmpDir, ENV, "managed-data", "alpha_user");
    const records = [
      { _id: "u1", name: "alice", mail: "alice@x.co" },
      { _id: "u2", name: "bob", mail: "bob@x.co" },
      { _id: "u3", name: "charlie", mail: "alice@y.co" },
    ];
    fs.writeFileSync(
      path.join(typeDir, "data.ndjson"),
      records.map((r) => JSON.stringify(r) + "\n").join(""),
    );
    await buildIndexFromNDJson(typeDir, (rec) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k.startsWith("_") && k !== "_id") continue;
        if (typeof v === "string") out[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      }
      return out;
    });
  });

  it("uses the index for no-query browsing without reading individual files", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(3);
    expect(page.records).toEqual([
      { id: "u1", title: "alice" },
      { id: "u2", title: "bob" },
      { id: "u3", title: "charlie" },
    ]);
    expect(page.fields.length).toBeGreaterThan(0);
  });

  it("searches indexed fields without file I/O", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "alice", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });

  it("paginates correctly from the index", async () => {
    const first = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 2,
      display: { title: "name", searchFields: [] },
    });
    expect(first.records.map((r) => r.id)).toEqual(["u1", "u2"]);
    const second = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 2, limit: 2,
      display: { title: "name", searchFields: [] },
    });
    expect(second.records.map((r) => r.id)).toEqual(["u3"]);
  });

  it("falls back to id when title field is not in the index", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "nonexistent", searchFields: [] },
    });
    expect(page.records[0].title).toBe("u1");
  });
});

describe("listRecords (NDJSON format)", () => {
  beforeEach(async () => {
    await writeNDJsonSnapshot(
      "alpha_user",
      [
        { _id: "u1", name: "alice", mail: "alice@x.co" },
        { _id: "u2", name: "bob", mail: "bob@x.co" },
        { _id: "u3", name: "charlie", mail: "alice@y.co" },
      ],
    );
  });

  it("paginates from the index", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(3);
    expect(page.records.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("searches via the index without scanning data.ndjson", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "alice", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });

  it("finds records via the SQLite index", async () => {
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "charlie", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(1);
    expect(page.records[0].id).toBe("u3");
  });
});

describe("listRecords on legacy {id}.json snapshots", () => {
  it("paginates by filename order", async () => {
    writeManifest("legacy_user", 3);
    writeRecord("legacy_user", "u1", { _id: "u1", userName: "alice" });
    writeRecord("legacy_user", "u2", { _id: "u2", userName: "bob" });
    writeRecord("legacy_user", "u3", { _id: "u3", userName: "carol" });

    const page = await listRecords(tmpDir, ENV, "legacy_user", {
      q: "", page: 1, limit: 10, display: { title: "userName", searchFields: [] },
    });
    expect(page.total).toBe(3);
    expect(page.records.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
    expect(page.records.map((r) => r.title)).toEqual(["alice", "bob", "carol"]);
  });

  it("substring-search across the full JSON text", async () => {
    writeManifest("legacy_user", 3);
    writeRecord("legacy_user", "u1", { _id: "u1", userName: "alice" });
    writeRecord("legacy_user", "u2", { _id: "u2", userName: "bob" });
    writeRecord("legacy_user", "u3", { _id: "u3", userName: "alice2" });

    const page = await listRecords(tmpDir, ENV, "legacy_user", {
      q: "alice", page: 1, limit: 10, display: { title: "userName", searchFields: [] },
    });
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
  });

  it("does not create index.sqlite for legacy snapshots", async () => {
    writeManifest("legacy_user", 1);
    writeRecord("legacy_user", "u1", { _id: "u1", userName: "alice" });

    await listRecords(tmpDir, ENV, "legacy_user", {
      q: "", page: 1, limit: 10, display: { title: "userName", searchFields: [] },
    });
    const typeDir = path.join(tmpDir, ENV, "managed-data", "legacy_user");
    expect(fs.existsSync(path.join(typeDir, "index.sqlite"))).toBe(false);
  });
});
