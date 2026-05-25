# AIC Studio M14 — Legacy Bundle Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement legacy `BundleV1` import end-to-end: parse + decrypt + map + persist + UI surfaces.

**Architecture:** Pure-core helpers (`legacyBundle.ts`, `legacyImport.ts`) in `src/core/env/`, exercised by a new command in `src/commands/env.ts`. New welcome view content for the Environments tree empty state. No schema migration.

**Tech Stack:** TypeScript, vitest, @vscode/test-electron, vscode SecretStorage, Node `crypto`.

**Branch:** `aic-studio/m14` branched from `aic-studio/m13`.

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m14 -b aic-studio/m14 aic-studio/m13
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m14/aic-studio
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
npm test          # baseline — should be 160 passing
```

---

## File Structure

```
aic-studio/src/core/env/legacyBundle.ts         NEW  — schema types + validateBundle + decryptSecrets
aic-studio/src/core/env/legacyBundle.test.ts    NEW
aic-studio/src/core/env/legacyImport.ts         NEW  — mapping + conflict planning
aic-studio/src/core/env/legacyImport.test.ts    NEW
aic-studio/src/core/db/environments.ts          MOD  — add updateEnvironment
aic-studio/src/core/db/environments.test.ts     MOD  — test it
aic-studio/src/core/db/opHistory.ts             MOD  — extend OpKind union
aic-studio/src/commands/env.ts                  MOD  — registerImportFromLegacyCommand
aic-studio/src/providers/envTree.ts             MOD  — (no code change; only package.json viewsWelcome contributes the empty-state button)
aic-studio/package.json                         MOD  — add command + viewsWelcome
aic-studio/tests/integration/suite/importLegacy.test.ts  NEW
aic-studio/esbuild.config.mjs                   MOD  — add new integration test entry
aic-studio/CHANGELOG.md                         MOD  — M14 section
```

---

## Task 1: Port `legacyBundle.ts` (types + validate + crypto)

**Files:** `src/core/env/legacyBundle.ts`, `src/core/env/legacyBundle.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/core/env/legacyBundle.test.ts
import { describe, it, expect } from "vitest";
import {
  BUNDLE_SCHEMA, REDACTED_SENTINEL,
  validateBundle, decryptSecrets, encryptSecrets, hasEncryptedValues,
  type BundleV1
} from "./legacyBundle";

describe("legacyBundle", () => {
  it("BUNDLE_SCHEMA matches the legacy app id", () => {
    expect(BUNDLE_SCHEMA).toBe("pinghub-environments/v1");
  });

  it("validateBundle accepts a minimal plain bundle", () => {
    const b: BundleV1 = {
      $schema: BUNDLE_SCHEMA,
      exportedAt: "2026-05-24T00:00:00Z",
      secretsIncluded: false,
      secretsEncryption: "none",
      environments: [
        { meta: { name: "dev", label: "Dev", color: "blue" }, envVars: { TENANT_BASE_URL: "https://x" } }
      ]
    };
    expect(() => validateBundle(b)).not.toThrow();
  });

  it("validateBundle rejects wrong $schema", () => {
    expect(() => validateBundle({ $schema: "wrong/v1", environments: [] }))
      .toThrow(/unsupported bundle schema/);
  });

  it("validateBundle rejects encrypted bundle missing kdf", () => {
    expect(() => validateBundle({
      $schema: BUNDLE_SCHEMA, exportedAt: "x",
      secretsIncluded: true, secretsEncryption: "passphrase-aes-256-gcm",
      environments: []
    })).toThrow(/missing kdf/);
  });

  it("encrypt + decrypt roundtrip preserves secrets", () => {
    const vars = { FRODO_PASSWORD: "hunter2", TENANT_BASE_URL: "https://x" };
    const { vars: enc, kdf } = encryptSecrets(vars, "correct horse battery staple");
    expect(hasEncryptedValues(enc)).toBe(true);
    expect(enc.TENANT_BASE_URL).toBe("https://x"); // not a secret key
    const dec = decryptSecrets(enc, "correct horse battery staple", kdf);
    expect(dec.FRODO_PASSWORD).toBe("hunter2");
    expect(dec.TENANT_BASE_URL).toBe("https://x");
  });

  it("decryptSecrets throws on wrong passphrase", () => {
    const { vars: enc, kdf } = encryptSecrets({ FRODO_PASSWORD: "x" }, "right");
    expect(() => decryptSecrets(enc, "wrong", kdf)).toThrow();
  });

  it("REDACTED_SENTINEL is preserved through validation", () => {
    expect(REDACTED_SENTINEL).toBe("<REDACTED>");
  });
});
```

- [ ] **Step 2: Run test → FAIL** (module not found)

Run: `npx vitest run src/core/env/legacyBundle.test.ts`
Expected: import errors.

- [ ] **Step 3: Implement `legacyBundle.ts`**

```ts
// src/core/env/legacyBundle.ts
import {
  randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv
} from "node:crypto";

export const BUNDLE_SCHEMA = "pinghub-environments/v1";
export const REDACTED_SENTINEL = "<REDACTED>";

export type SecretsMode = "exclude" | "plain" | "encrypted";

export interface EncryptedValue {
  _enc: "aes-256-gcm";
  iv: string;
  tag: string;
  ct: string;
}

export interface LegacyEnvMeta {
  name: string;
  label: string;
  color: string;
  // legacy-only fields ignored during import:
  type?: string;
  devEnvironment?: boolean;
  pageSize?: number;
  healthIntervalMinutes?: number;
}

export interface BundleEnvEntry {
  meta: LegacyEnvMeta;
  envVars: Record<string, string | EncryptedValue>;
  files?: Record<string, unknown>;
}

export interface BundleV1 {
  $schema: typeof BUNDLE_SCHEMA;
  exportedAt: string;
  exportedBy?: string;
  appVersion?: string;
  secretsIncluded: boolean;
  secretsEncryption: "none" | "passphrase-aes-256-gcm";
  kdf?: { algo: "pbkdf2"; hash: "sha256"; iter: number; salt: string };
  environments: BundleEnvEntry[];
}

export const SECRET_KEYS = new Set<string>([
  "SERVICE_ACCOUNT_KEY",
  "SERVICE_ACCOUNT_CLIENT_SECRET",
  "RCS_PRIVATE_KEY",
  "FRODO_SA_JWK",
  "FRODO_PASSWORD",
  "LOG_API_KEY",
  "LOG_API_SECRET"
]);

const SECRET_SUFFIXES = ["_SECRET", "_PASSWORD", "_TOKEN", "_PRIVATE_KEY", "_API_KEY"];

export function isSecretKey(name: string): boolean {
  if (SECRET_KEYS.has(name)) return true;
  const u = name.toUpperCase();
  return SECRET_SUFFIXES.some((s) => u.endsWith(s));
}

const PBKDF2_ITER = 200_000;
const KEY_LEN = 32;
const IV_LEN = 12;

function deriveKey(passphrase: string, salt: Buffer, iter = PBKDF2_ITER): Buffer {
  return pbkdf2Sync(passphrase, salt, iter, KEY_LEN, "sha256");
}

export function encryptSecrets(
  vars: Record<string, string>,
  passphrase: string,
  saltOverride?: Buffer
): { vars: Record<string, string | EncryptedValue>; kdf: NonNullable<BundleV1["kdf"]> } {
  if (!passphrase || passphrase.length < 6) {
    throw new Error("passphrase must be at least 6 characters");
  }
  const salt = saltOverride ?? randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const out: Record<string, string | EncryptedValue> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (isSecretKey(k) && v) {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(v, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      out[k] = {
        _enc: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ct: ct.toString("base64")
      };
    } else {
      out[k] = v;
    }
  }
  return {
    vars: out,
    kdf: { algo: "pbkdf2", hash: "sha256", iter: PBKDF2_ITER, salt: salt.toString("base64") }
  };
}

export function decryptSecrets(
  vars: Record<string, string | EncryptedValue>,
  passphrase: string,
  kdf: NonNullable<BundleV1["kdf"]>
): Record<string, string> {
  const salt = Buffer.from(kdf.salt, "base64");
  const key = deriveKey(passphrase, salt, kdf.iter);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string") {
      out[k] = v;
      continue;
    }
    if (v && v._enc === "aes-256-gcm") {
      const iv = Buffer.from(v.iv, "base64");
      const tag = Buffer.from(v.tag, "base64");
      const ct = Buffer.from(v.ct, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      out[k] = plain.toString("utf8");
    }
  }
  return out;
}

export function hasEncryptedValues(vars: Record<string, string | EncryptedValue>): boolean {
  return Object.values(vars).some((v) => typeof v !== "string" && v?._enc === "aes-256-gcm");
}

export function materializeEnvVars(
  entry: BundleEnvEntry,
  bundle: BundleV1,
  passphrase?: string
): Record<string, string> {
  if (!hasEncryptedValues(entry.envVars)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.envVars)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  if (!passphrase) throw new Error("bundle has encrypted secrets — passphrase required");
  if (!bundle.kdf) throw new Error("bundle has encrypted secrets but no kdf");
  return decryptSecrets(entry.envVars, passphrase, bundle.kdf);
}

export function validateBundle(input: unknown): asserts input is BundleV1 {
  if (!input || typeof input !== "object") throw new Error("bundle is not an object");
  const b = input as Partial<BundleV1>;
  if (b.$schema !== BUNDLE_SCHEMA) {
    throw new Error(`unsupported bundle schema: ${String(b.$schema)} (expected ${BUNDLE_SCHEMA})`);
  }
  if (!Array.isArray(b.environments)) throw new Error("bundle.environments missing or not an array");
  for (const e of b.environments) {
    if (!e || typeof e !== "object") throw new Error("bundle entry is not an object");
    if (!e.meta || typeof e.meta.name !== "string") throw new Error("bundle entry missing meta.name");
    if (!e.envVars || typeof e.envVars !== "object") {
      throw new Error(`bundle entry "${e.meta?.name}" missing envVars`);
    }
  }
  if (b.secretsEncryption === "passphrase-aes-256-gcm" && !b.kdf) {
    throw new Error("encrypted bundle missing kdf parameters");
  }
}
```

- [ ] **Step 4: Run test → PASS** (7/7)

- [ ] **Step 5: Commit**

```bash
git add src/core/env/legacyBundle.ts src/core/env/legacyBundle.test.ts
git commit -m "feat(aic-studio): port legacy BundleV1 schema + AES-256-GCM decrypt"
```

---

## Task 2: Implement `legacyImport.ts` mapping + conflict planning

**Files:** `src/core/env/legacyImport.ts`, `src/core/env/legacyImport.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/core/env/legacyImport.test.ts
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
```

- [ ] **Step 2: Run test → FAIL** (module not found)

- [ ] **Step 3: Implement `legacyImport.ts`**

```ts
// src/core/env/legacyImport.ts
import type { Database } from "better-sqlite3";
import { getEnvironmentByName } from "../db/environments";
import type { BundleEnvEntry } from "./legacyBundle";
import type { NewEnvironment, EnvironmentColor } from "./types";

const COLOR_MAP: Record<string, EnvironmentColor> = {
  blue: "blue",
  green: "green",
  yellow: "yellow",
  red: "red",
  slate: "slate"
  // legacy purple/orange/teal/pink/indigo/gray → fall through to "slate"
};

const NAME_INVALID = /[^a-z0-9\-_]/g;

function normalizeName(raw: string): string {
  const lower = raw.toLowerCase();
  const sanitized = lower.replace(NAME_INVALID, "-");
  // ensure leading char matches [a-z0-9]
  return /^[a-z0-9]/.test(sanitized) ? sanitized : `e-${sanitized}`;
}

function mapColor(c: string | undefined): EnvironmentColor {
  if (!c) return "slate";
  return COLOR_MAP[c.toLowerCase()] ?? "slate";
}

export function mapBundleEntryToEnvironment(
  entry: BundleEnvEntry,
  vars: Record<string, string>
): { env?: NewEnvironment; errors: string[] } {
  const errors: string[] = [];
  const tenantUrl = (vars.TENANT_BASE_URL ?? "").trim();
  const clientId = (vars.SERVICE_ACCOUNT_ID ?? vars.FRODO_SA_ID ?? "").trim();
  const username = (vars.FRODO_USERNAME ?? "").trim() || clientId;

  if (!tenantUrl) errors.push("missing TENANT_BASE_URL");
  if (!clientId) errors.push("missing SERVICE_ACCOUNT_ID");
  if (errors.length) return { errors };

  return {
    env: {
      name: normalizeName(entry.meta.name),
      label: entry.meta.label || entry.meta.name,
      tenantUrl,
      username,
      clientId,
      color: mapColor(entry.meta.color)
    },
    errors: []
  };
}

const REDACTED = "<REDACTED>";

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v !== REDACTED;
}

export interface LegacyLogApiFile {
  apiKey?: string;
  apiSecret?: string;
}

export function mapBundleEntryToSecrets(
  entry: BundleEnvEntry,
  vars: Record<string, string>
): Partial<Record<"client-secret" | "password" | "log-api-key" | "log-api-secret", string>> {
  const out: Partial<Record<"client-secret" | "password" | "log-api-key" | "log-api-secret", string>> = {};
  if (nonEmpty(vars.SERVICE_ACCOUNT_CLIENT_SECRET)) out["client-secret"] = vars.SERVICE_ACCOUNT_CLIENT_SECRET;
  if (nonEmpty(vars.FRODO_PASSWORD)) out["password"] = vars.FRODO_PASSWORD;
  if (nonEmpty(vars.LOG_API_KEY)) {
    out["log-api-key"] = vars.LOG_API_KEY;
  } else {
    const file = entry.files?.["log-api.json"] as LegacyLogApiFile | undefined;
    if (file && nonEmpty(file.apiKey)) out["log-api-key"] = file.apiKey;
  }
  if (nonEmpty(vars.LOG_API_SECRET)) {
    out["log-api-secret"] = vars.LOG_API_SECRET;
  } else {
    const file = entry.files?.["log-api.json"] as LegacyLogApiFile | undefined;
    if (file && nonEmpty(file.apiSecret)) out["log-api-secret"] = file.apiSecret;
  }
  return out;
}

export interface ConflictRow {
  bundleName: string;
  normalizedName: string;
  exists: boolean;
}

export type ImportPlan = ConflictRow[];

export function planConflicts(db: Database, entries: BundleEnvEntry[]): ImportPlan {
  return entries.map((e) => {
    const normalized = normalizeName(e.meta.name);
    return {
      bundleName: e.meta.name,
      normalizedName: normalized,
      exists: !!getEnvironmentByName(db, normalized)
    };
  });
}

// Exposed for callers that want the same normalization logic.
export const _testing = { normalizeName, mapColor };
```

- [ ] **Step 4: Run test → PASS** (10/10)

- [ ] **Step 5: Commit**

```bash
git add src/core/env/legacyImport.ts src/core/env/legacyImport.test.ts
git commit -m "feat(aic-studio): legacy bundle field mapping + conflict planning"
```

---

## Task 3: Add `updateEnvironment` to db/environments.ts

**Files:** `src/core/db/environments.ts`, `src/core/db/environments.test.ts`

- [ ] **Step 1: Append failing test**

```ts
// add to src/core/db/environments.test.ts
import { updateEnvironment } from "./environments";

describe("updateEnvironment", () => {
  it("updates an existing env in place", () => {
    const db = new Database(":memory:"); runMigrations(db);
    insertEnvironment(db, { name: "dev", label: "Old", tenantUrl: "https://a", username: "u", clientId: "c", color: "slate" });
    updateEnvironment(db, { name: "dev", label: "New", tenantUrl: "https://b", username: "u2", clientId: "c2", color: "green" });
    const got = getEnvironmentByName(db, "dev");
    expect(got!.label).toBe("New");
    expect(got!.tenantUrl).toBe("https://b");
    expect(got!.username).toBe("u2");
    expect(got!.clientId).toBe("c2");
    expect(got!.color).toBe("green");
  });

  it("throws when env does not exist", () => {
    const db = new Database(":memory:"); runMigrations(db);
    expect(() =>
      updateEnvironment(db, { name: "missing", label: "L", tenantUrl: "https://x", username: "u", clientId: "c", color: "slate" })
    ).toThrow(/no such environment/);
  });
});
```

- [ ] **Step 2: Run test → FAIL** (export missing)

- [ ] **Step 3: Implement `updateEnvironment`**

Add to `src/core/db/environments.ts` after `insertEnvironment`:

```ts
export function updateEnvironment(db: Database, input: NewEnvironment): void {
  const parsed = NewEnvironmentSchema.parse(input);
  const now = Date.now();
  const r = db.prepare(`
    UPDATE environments
       SET label = ?, tenant_url = ?, username = ?, client_id = ?, color = ?, updated_at = ?
     WHERE name = ?
  `).run(parsed.label, parsed.tenantUrl, parsed.username, parsed.clientId, parsed.color, now, parsed.name);
  if (r.changes === 0) throw new Error(`no such environment: ${parsed.name}`);
}
```

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

```bash
git add src/core/db/environments.ts src/core/db/environments.test.ts
git commit -m "feat(aic-studio): add updateEnvironment for in-place env writes"
```

---

## Task 4: Extend `OpKind` to include "import-legacy"

**File:** `src/core/db/opHistory.ts`

- [ ] **Step 1: Locate the `OpKind` type alias** (`grep -n "type OpKind" src/core/db/opHistory.ts`)

- [ ] **Step 2: Extend the union** to include `"import-legacy"`. No runtime change; the column has no CHECK constraint.

- [ ] **Step 3: Run `npm test` and `npm run typecheck`** to confirm nothing else needs updating. (If there are exhaustive switches over OpKind in the codebase — e.g., in History tree or webview rendering — add a `case "import-legacy":` branch with a sensible label like "Import from legacy bundle".)

- [ ] **Step 4: Commit**

```bash
git add src/core/db/opHistory.ts $(possibly history rendering files)
git commit -m "feat(aic-studio): add import-legacy OpKind for op_history"
```

---

## Task 5: Implement the command in `commands/env.ts`

**File:** `src/commands/env.ts`

This is the orchestration layer. It must NOT contain mapping logic (that's in `legacyImport.ts`) or crypto (that's in `legacyBundle.ts`).

- [ ] **Step 1: Add the command handler**

Pattern (paraphrased — implementer should fit it into the existing `registerEnvCommands` shape):

```ts
async function importFromLegacy(deps: EnvCmdDeps): Promise<void> {
  // 1. Pick file
  const uris = await vscode.window.showOpenDialog({
    filters: { JSON: ["json"] },
    canSelectMany: false,
    openLabel: "Import bundle"
  });
  if (!uris?.length) return;
  const filePath = uris[0].fsPath;
  let raw: string;
  try { raw = await fs.promises.readFile(filePath, "utf-8"); }
  catch (e) { vscode.window.showErrorMessage(`Failed to read file: ${(e as Error).message}`); return; }

  let bundle: BundleV1;
  try {
    const parsed = JSON.parse(raw);
    validateBundle(parsed);
    bundle = parsed;
  } catch (e) {
    vscode.window.showErrorMessage(`Invalid bundle: ${(e as Error).message}`);
    return;
  }

  // 2. Passphrase if encrypted
  let passphrase: string | undefined;
  if (bundle.secretsEncryption === "passphrase-aes-256-gcm") {
    passphrase = await vscode.window.showInputBox({
      password: true,
      prompt: "Bundle passphrase",
      placeHolder: "Required to decrypt secrets",
      ignoreFocusOut: true
    });
    if (!passphrase) return;
  }

  // 3. Per-env selection
  const plan = planConflicts(deps.db, bundle.environments);
  const selected = await vscode.window.showQuickPick(
    plan.map((p, i) => ({
      label: p.normalizedName,
      description: p.exists ? "exists — will prompt for action" : "new",
      detail: p.bundleName !== p.normalizedName ? `was: ${p.bundleName}` : undefined,
      picked: true,
      _idx: i
    })),
    { canPickMany: true, title: "Select environments to import" }
  );
  if (!selected?.length) return;

  // 4. Per-conflict action
  const decisions = new Map<number, "skip"|"overwrite"|"rename"|"insert">();
  const renames = new Map<number, string>();
  for (const item of selected) {
    const row = plan[item._idx];
    if (!row.exists) { decisions.set(item._idx, "insert"); continue; }
    const action = await vscode.window.showQuickPick(
      [
        { label: "skip", description: "leave existing env unchanged" },
        { label: "overwrite", description: "replace existing env's config + secrets" },
        { label: "rename", description: "import under a new name" }
      ],
      { title: `Conflict for "${row.normalizedName}"` }
    );
    if (!action) return; // user cancelled
    if (action.label === "rename") {
      const newName = await vscode.window.showInputBox({
        prompt: "New name",
        value: `${row.normalizedName}-imported`,
        validateInput: (v) => /^[a-z0-9][a-z0-9-_]*$/.test(v) ? null : "lowercase alphanumeric (with - or _)"
      });
      if (!newName) return;
      renames.set(item._idx, newName);
      decisions.set(item._idx, "rename");
    } else {
      decisions.set(item._idx, action.label as "skip" | "overwrite");
    }
  }

  // 5. Apply
  let applied = 0, skipped = 0, failed = 0;
  const failures: string[] = [];
  for (const item of selected) {
    const idx = item._idx;
    const decision = decisions.get(idx);
    if (!decision || decision === "skip") { skipped++; continue; }
    const entry = bundle.environments[idx];
    try {
      const vars = materializeEnvVars(entry, bundle, passphrase);
      const { env, errors } = mapBundleEntryToEnvironment(entry, vars);
      if (!env) throw new Error(errors.join("; "));
      if (decision === "rename") env.name = renames.get(idx)!;
      if (decision === "overwrite") {
        updateEnvironment(deps.db, env);
      } else {
        insertEnvironment(deps.db, env);
      }
      const secrets = mapBundleEntryToSecrets(entry, vars);
      for (const [kind, val] of Object.entries(secrets) as Array<[SecretKind, string]>) {
        await deps.secrets.set(env.name, kind, val);
      }
      recordOperation(deps.db, {
        envName: env.name,
        opKind: "import-legacy",
        status: "ok",
        message: `imported from ${path.basename(filePath)}`,
        startedAt: Date.now(),
        finishedAt: Date.now()
      });
      applied++;
    } catch (e) {
      failed++;
      failures.push(`${entry.meta.name}: ${(e as Error).message}`);
    }
  }

  deps.onChange();

  const msg = `Imported ${applied} · skipped ${skipped} · failed ${failed}`;
  if (failed) {
    vscode.window.showWarningMessage(msg, { detail: failures.join("\n"), modal: true });
  } else {
    vscode.window.showInformationMessage(msg);
  }
}
```

The handler must be registered via `ctx.subscriptions.push(vscode.commands.registerCommand("aic-studio.env.importFromLegacy", () => importFromLegacy(deps)))`.

- [ ] **Step 2: Update integration test** (will land in Task 7) to assert the command is registered.

- [ ] **Step 3: Commit**

```bash
git add src/commands/env.ts
git commit -m "feat(aic-studio): aic-studio.env.importFromLegacy command"
```

---

## Task 6: package.json contributes

**File:** `aic-studio/package.json`

- [ ] **Step 1: Add the command to `contributes.commands`**

```jsonc
{
  "command": "aic-studio.env.importFromLegacy",
  "title": "Import Environments from Legacy Bundle…",
  "category": "AIC Studio"
}
```

- [ ] **Step 2: Add `contributes.viewsWelcome` for empty Environments tree**

```jsonc
"viewsWelcome": [
  {
    "view": "aic-studio.envs",
    "contents": "No environments yet.\n[Add Environment](command:aic-studio.env.add)\n[Import from aic-pipeline](command:aic-studio.env.importFromLegacy)"
  }
]
```

(View id may differ — confirm by checking `package.json` for the registered Environments view id; reuse it verbatim.)

- [ ] **Step 3: Run `npm run build`** to confirm package.json is valid.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat(aic-studio): contribute importFromLegacy command + welcome view"
```

---

## Task 7: Integration test

**File:** `aic-studio/tests/integration/suite/importLegacy.test.ts`

- [ ] **Step 1: Write minimal smoke test**

```ts
import * as vscode from "vscode";
import * as assert from "node:assert/strict";

suite("Legacy import", () => {
  test("env.importFromLegacy is registered", async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes("aic-studio.env.importFromLegacy"),
      "command not registered");
  });
});
```

- [ ] **Step 2: Add to `esbuild.config.mjs` `integrationTestConfig.entryPoints`**

- [ ] **Step 3: Build + run**

```bash
npm run build
npm run test:integration
```

Expected: existing 44 + 1 = 45 passing.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/suite/importLegacy.test.ts esbuild.config.mjs
git commit -m "test(aic-studio): integration smoke test for importFromLegacy"
```

---

## Task 8: CHANGELOG + acceptance gate

**File:** `aic-studio/CHANGELOG.md`

- [ ] **Step 1: Add M14 section above the `## [1.0.0]` heading**

```markdown
## [Unreleased] — M14: Legacy bundle import

### Added
- `AIC Studio: Import Environments from Legacy Bundle…` command (palette + Environments empty-state welcome).
- Reads `pinghub-environments/v1` bundle JSON produced by the legacy aic-pipeline app.
- Supports plaintext, redacted, and AES-256-GCM passphrase-encrypted bundles.
- Per-env skip / overwrite / rename conflict resolution.
- Maps `TENANT_BASE_URL`, `SERVICE_ACCOUNT_ID`, `FRODO_USERNAME` to Environment fields.
- Imports secrets (`SERVICE_ACCOUNT_CLIENT_SECRET`, `FRODO_PASSWORD`, `LOG_API_KEY`, `LOG_API_SECRET`) to SecretStorage.
- Falls back to `log-api.json` companion for log API credentials when not in `.env`.
- Records each imported env as an `import-legacy` row in op_history.
```

- [ ] **Step 2: Acceptance gate**

```bash
npm rebuild better-sqlite3
npm test                                                                     # expect 160 + new tests
npm run typecheck
npm run build
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
npm run test:integration                                                     # expect 44 + 1 = 45
```

All four must pass.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(aic-studio): CHANGELOG for M14 legacy import"
```

---

## Self-Review

**Spec coverage:**
- §2 format → Task 1 ✓
- §3 mapping → Task 2 ✓
- §4 UX → Tasks 5 + 6 ✓
- §5 data layer → Tasks 3 + 4 ✓
- §6 code layout → all tasks ✓
- §7 security: passphrase not persisted ✓, REDACTED sentinel handled ✓, no path traversal (file URI from showOpenDialog only) ✓
- §8 tests → Tasks 1, 2, 3, 7 ✓
- §10 acceptance criteria → Task 8 gate ✓

**Placeholder scan:** All code blocks are concrete. The one judgment call left to the implementer is "if there are exhaustive switches over OpKind, add a case" in Task 4 — that's explicit, with the label spelled out.

**Type consistency:** `NewEnvironment` re-used as the input type for `updateEnvironment` (matches `insertEnvironment`); `SecretKind` re-used in the command from `core/env/secrets.ts`; `BundleV1` and `BundleEnvEntry` re-used from `legacyBundle.ts` in `legacyImport.ts` and the command.

Plan ready.
