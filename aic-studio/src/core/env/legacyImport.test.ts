import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../db/connection";
import { insertEnvironment } from "../db/environments";
import {
  mapBundleEntryToEnvironment,
  mapBundleEntryToSecrets,
  planConflicts,
  type ImportPlan
} from "./legacyImport";
import type { BundleEnvEntry } from "./legacyBundle";

const fullEntry: BundleEnvEntry = {
  meta: { name: "dev", label: "Dev", color: "blue" },
  envVars: {
    TENANT_BASE_URL: "https://t.example",
    SERVICE_ACCOUNT_ID: "sa-id-123",
    FRODO_USERNAME: "alice",
    SERVICE_ACCOUNT_CLIENT_SECRET: "csec",
    FRODO_PASSWORD: "pw",
    LOG_API_KEY: "lk",
    LOG_API_SECRET: "ls"
  }
};

describe("legacyImport", () => {
  describe("mapBundleEntryToEnvironment", () => {
    it("maps a complete plain entry", () => {
      const { env, errors } = mapBundleEntryToEnvironment(fullEntry, fullEntry.envVars as Record<string, string>);
      expect(errors).toEqual([]);
      expect(env).toMatchObject({
        name: "dev",
        label: "Dev",
        tenantUrl: "https://t.example",
        clientId: "sa-id-123",
        username: "alice",
        color: "blue"
      });
    });

    it("maps unsupported color to slate", () => {
      const entry = { ...fullEntry, meta: { ...fullEntry.meta, color: "purple" } };
      const { env, errors } = mapBundleEntryToEnvironment(entry, entry.envVars as Record<string, string>);
      expect(errors).toEqual([]);
      expect(env!.color).toBe("slate");
    });

    it("normalizes a bad name", () => {
      const entry = { ...fullEntry, meta: { ...fullEntry.meta, name: "Prod-East!" } };
      const { env } = mapBundleEntryToEnvironment(entry, entry.envVars as Record<string, string>);
      expect(env!.name).toBe("prod-east-");
    });

    it("falls back username from SERVICE_ACCOUNT_ID when FRODO_USERNAME missing", () => {
      const vars = { ...fullEntry.envVars, FRODO_USERNAME: "" } as Record<string, string>;
      const { env } = mapBundleEntryToEnvironment(fullEntry, vars);
      expect(env!.username).toBe("sa-id-123");
    });

    it("reports missing TENANT_BASE_URL", () => {
      const vars = { ...fullEntry.envVars, TENANT_BASE_URL: "" } as Record<string, string>;
      const { env, errors } = mapBundleEntryToEnvironment(fullEntry, vars);
      expect(env).toBeUndefined();
      expect(errors.join(" ")).toMatch(/TENANT_BASE_URL/);
    });

    it("reports missing SERVICE_ACCOUNT_ID", () => {
      const vars = { ...fullEntry.envVars, SERVICE_ACCOUNT_ID: "" } as Record<string, string>;
      const { env, errors } = mapBundleEntryToEnvironment(fullEntry, vars);
      expect(env).toBeUndefined();
      expect(errors.join(" ")).toMatch(/SERVICE_ACCOUNT_ID/);
    });
  });

  describe("mapBundleEntryToSecrets", () => {
    it("collects all four kinds from envVars", () => {
      const out = mapBundleEntryToSecrets(fullEntry, fullEntry.envVars as Record<string, string>);
      expect(out).toEqual({
        "client-secret": "csec",
        "password": "pw",
        "log-api-key": "lk",
        "log-api-secret": "ls"
      });
    });

    it("uses log-api.json as fallback when LOG_API_KEY missing", () => {
      const entry: BundleEnvEntry = {
        ...fullEntry,
        envVars: { ...fullEntry.envVars, LOG_API_KEY: "", LOG_API_SECRET: "" },
        files: { "log-api.json": { apiKey: "from-file", apiSecret: "from-file-s" } }
      };
      const vars = entry.envVars as Record<string, string>;
      const out = mapBundleEntryToSecrets(entry, vars);
      expect(out["log-api-key"]).toBe("from-file");
      expect(out["log-api-secret"]).toBe("from-file-s");
    });

    it("skips REDACTED and empty values", () => {
      const vars: Record<string, string> = {
        SERVICE_ACCOUNT_CLIENT_SECRET: "<REDACTED>",
        FRODO_PASSWORD: ""
      };
      const out = mapBundleEntryToSecrets(fullEntry, vars);
      expect(out["client-secret"]).toBeUndefined();
      expect(out["password"]).toBeUndefined();
    });
  });

  describe("planConflicts", () => {
    let db: ReturnType<typeof Database>;
    beforeEach(() => {
      db = new Database(":memory:");
      runMigrations(db);
    });

    it("flags an existing env name as a conflict", () => {
      insertEnvironment(db, {
        name: "dev", label: "Existing", tenantUrl: "https://e", username: "u", clientId: "c", color: "slate"
      });
      const plan: ImportPlan = planConflicts(db, [fullEntry]);
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ bundleName: "dev", normalizedName: "dev", exists: true });
    });

    it("no conflict when name is unique", () => {
      const plan = planConflicts(db, [fullEntry]);
      expect(plan[0].exists).toBe(false);
    });
  });
});
