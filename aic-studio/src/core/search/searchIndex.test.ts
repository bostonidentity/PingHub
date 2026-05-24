// src/core/search/searchIndex.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../db/connection";
import { insertEnvironment } from "../db/environments";
import { createPromotionTask } from "../db/promotionTasks";
import { buildSearchIndex, queryIndex } from "./searchIndex";

let db: Database;
let storage: string;

beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), "search-"));
  db = openDatabase(join(storage, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(storage, { recursive: true, force: true });
});

function seedJourney(envName: string, stamp: string, realm: string, id: string) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ _id: id }));
}

function seedFederation(envName: string, stamp: string, realm: string, type: string, id: string) {
  const dir = join(storage, "snapshots", envName, stamp, realm, "federation", type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ _id: id }));
}

describe("buildSearchIndex", () => {
  it("returns [] when empty", () => {
    expect(buildSearchIndex(db, storage)).toEqual([]);
  });

  it("indexes environments", () => {
    insertEnvironment(db, {
      name: "prod", label: "Production",
      tenantUrl: "https://prod.id.forgerock.io",
      username: "u", clientId: "c", color: "blue"
    });
    const idx = buildSearchIndex(db, storage);
    expect(idx).toHaveLength(1);
    expect(idx[0].kind).toBe("env");
    expect(idx[0].label).toBe("Production");
  });

  it("indexes journeys + federation from latest snapshot", () => {
    insertEnvironment(db, {
      name: "prod", label: "P",
      tenantUrl: "https://x", username: "u", clientId: "c", color: "blue"
    });
    seedJourney("prod", "2026-05-24T10-00-00Z", "alpha", "Login");
    seedFederation("prod", "2026-05-24T10-00-00Z", "alpha", "saml2", "sp-acme");
    const idx = buildSearchIndex(db, storage);
    expect(idx.filter((i) => i.kind === "journey")).toHaveLength(1);
    expect(idx.filter((i) => i.kind === "federation")).toHaveLength(1);
  });

  it("indexes promotion tasks", () => {
    insertEnvironment(db, {
      name: "prod", label: "P",
      tenantUrl: "https://x", username: "u", clientId: "c", color: "blue"
    });
    createPromotionTask(db, { name: "release-1", sourceEnv: "prod" });
    const idx = buildSearchIndex(db, storage);
    expect(idx.filter((i) => i.kind === "promotionTask")).toHaveLength(1);
    expect(idx.find((i) => i.kind === "promotionTask")?.label).toBe("release-1");
  });
});

describe("queryIndex", () => {
  it("returns all items for empty query", () => {
    const items = [
      { label: "Login", detail: "prod · alpha · journey", kind: "journey" as const },
      { label: "Register", detail: "prod · alpha · journey", kind: "journey" as const }
    ];
    expect(queryIndex(items, "")).toEqual(items);
  });

  it("filters by label substring (case-insensitive)", () => {
    const items = [
      { label: "Login", detail: "prod · alpha · journey", kind: "journey" as const },
      { label: "Register", detail: "prod · alpha · journey", kind: "journey" as const }
    ];
    expect(queryIndex(items, "log")).toHaveLength(1);
    expect(queryIndex(items, "LOGIN")).toHaveLength(1);
  });

  it("filters by detail substring", () => {
    const items = [
      { label: "Login", detail: "prod · alpha", kind: "journey" as const },
      { label: "Register", detail: "stage · alpha", kind: "journey" as const }
    ];
    expect(queryIndex(items, "stage")).toHaveLength(1);
  });
});
