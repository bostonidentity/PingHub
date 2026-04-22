import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { listSnapshotTypes, readRecord, listRecords, evictCache } from "./snapshot-fs";

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
  beforeEach(() => {
    writeManifest("alpha_user", 3);
    writeRecord("alpha_user", "u1", { _id: "u1", name: "alice", mail: "alice@x.co" });
    writeRecord("alpha_user", "u2", { _id: "u2", name: "bob", mail: "bob@x.co" });
    writeRecord("alpha_user", "u3", { _id: "u3", name: "charlie", mail: "alice@y.co" });
  });

  it("returns all records paginated by id order", async () => {
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

  it("full-JSON search matches any key or value in the record", async () => {
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

  it("full-JSON search matches on keys too", async () => {
    // "mail" is a key in every record.
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "mail",
      page: 1,
      limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.total).toBe(3);
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
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "name", searchFields: [] },
    });
    expect(page.records.find((r) => r.id === "u4")?.title).toBe("u4");
  });

  it("honors titleField override and matches case-insensitively", async () => {
    // Record uses capital-N Name; override asks for lower-case "name".
    writeRecord("alpha_user", "u5", { _id: "u5", Name: "Overridden" });
    const page = await listRecords(tmpDir, ENV, "alpha_user", {
      q: "", page: 1, limit: 10,
      display: { title: "_id", searchFields: [] },
      titleField: "name",
    });
    expect(page.records.find((r) => r.id === "u5")?.title).toBe("Overridden");
  });
});

// ── Index-accelerated path ─────────────────────────────────────────────────

function writeIndex(type: string, entries: { id: string; f: Record<string, string> }[]) {
  const dir = path.join(tmpDir, ENV, "managed-data", type);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "_index.json"), JSON.stringify(entries));
}

describe("listRecords with _index.json", () => {
  beforeEach(() => {
    writeManifest("alpha_user", 3);
    writeRecord("alpha_user", "u1", { _id: "u1", name: "alice", mail: "alice@x.co" });
    writeRecord("alpha_user", "u2", { _id: "u2", name: "bob", mail: "bob@x.co" });
    writeRecord("alpha_user", "u3", { _id: "u3", name: "charlie", mail: "alice@y.co" });
    writeIndex("alpha_user", [
      { id: "u1", f: { _id: "u1", name: "alice", mail: "alice@x.co" } },
      { id: "u2", f: { _id: "u2", name: "bob", mail: "bob@x.co" } },
      { id: "u3", f: { _id: "u3", name: "charlie", mail: "alice@y.co" } },
    ]);
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
