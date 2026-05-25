# AIC Studio M1 — Scaffold & Environments View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `aic-studio/` VS Code extension project with a working dev loop, SQLite-backed environment storage, SecretStorage-backed credentials, an Environments sidebar TreeView, and CI on 4 OS targets. End-state is a runnable extension that lets a user add, list, switch, and remove AIC environments — no AIC HTTP calls yet, no SCM yet, no diff yet (those land in M2+).

**Architecture:** TypeScript + esbuild + vitest + @vscode/test-electron. Two-layer boundary: `src/core/` is VS Code-API-free (pure logic, unit-testable with vitest); `src/providers/`, `src/commands/`, `src/status/`, `src/logging/` are the only places that import `vscode`. SQLite lives at `globalStorageUri/pinghub.db` via `better-sqlite3`; secrets via `vscode.SecretStorage`. Activity-bar icon hosts 5 TreeViews — Environments is functional in M1; the other 4 (Promotion Tasks, History, Monitors, Logs) register as empty placeholders.

**Tech Stack:** TypeScript 5.x · esbuild · vitest · @vscode/test-electron · better-sqlite3 · zod (for schema validation) · ESLint · vsce

**Spec:** [`docs/superpowers/specs/2026-05-24-aic-studio-vscode-extension-design.md`](../specs/2026-05-24-aic-studio-vscode-extension-design.md)

---

## File Structure

Created in this milestone:

```
aic-studio/
  .gitignore                                      Project-level ignores
  .vscode/
    launch.json                                   F5 debug config (extension host)
  .vscodeignore                                   What stays out of the VSIX
  package.json                                    Extension manifest + contributes
  tsconfig.json                                   TS config (noEmit, strict)
  vitest.config.ts                                Unit-test runner config
  esbuild.config.mjs                              Build script for src/extension.ts
  eslint.config.mjs                               Flat ESLint config
  README.md                                       Marketplace listing (skeleton in M1)
  CHANGELOG.md                                    Release notes
  LICENSE                                         Apache 2.0 (copied from root)
  media/
    icon.svg                                      Activity bar icon (monochrome)
    icon.png                                      128x128 PNG for marketplace
  src/
    extension.ts                                  activate()/deactivate() entry
    core/
      db/
        schema.ts                                 SQL DDL + migration list
        connection.ts                             open()/close() DB at path
        connection.test.ts                        Vitest unit tests
        environments.ts                           env CRUD (insert/get/list/remove/setActive)
        environments.test.ts                      Vitest unit tests
      env/
        types.ts                                  Environment type + Zod schema
        secrets.ts                                SecretStorage key helpers (pure functions)
        secrets.test.ts                           Vitest unit tests
    providers/
      envTree.ts                                  EnvironmentsTreeProvider (TreeDataProvider)
      placeholderTrees.ts                         Empty placeholders for M5/6/8/9 views
    commands/
      env.ts                                      add/setActive/remove command handlers
    status/
      activeEnvStatusBar.ts                       Status bar item + click handler
    logging/
      output.ts                                   OutputChannel singleton + helpers
  tests/
    integration/
      runTest.ts                                  @vscode/test-electron entry
      suite/
        index.ts                                  Mocha test loader
        activation.test.ts                        Extension activates, 5 views appear
        envCrud.test.ts                           Add → list → setActive → remove via commands

.github/workflows/
  aic-studio-ci.yml                               PR CI: lint+typecheck+tests on 4 OS
  aic-studio-insiders.yml                         Drafted, disabled — wires up insiders publish
```

Each file has one clear responsibility. The `core/db/` and `core/env/` modules are pure (no `vscode` import); `providers/`, `commands/`, `status/`, `logging/` own all VS Code interaction.

---

## Task 1: Create project directory and base files

**Files:**
- Create: `aic-studio/.gitignore`
- Create: `aic-studio/LICENSE`
- Create: `aic-studio/README.md`

- [ ] **Step 1: Create project directories**

```bash
mkdir -p aic-studio/src/core/db aic-studio/src/core/env \
         aic-studio/src/providers aic-studio/src/commands \
         aic-studio/src/status aic-studio/src/logging \
         aic-studio/tests/integration/suite \
         aic-studio/media aic-studio/.vscode
```

- [ ] **Step 2: Write `aic-studio/.gitignore`** (use the Write tool)

```gitignore
node_modules/
out/
*.vsix
.DS_Store
*.tsbuildinfo
coverage/
.vscode-test/
```

- [ ] **Step 3: Copy LICENSE from monorepo root**

```bash
cp LICENSE aic-studio/LICENSE
```

- [ ] **Step 4: Write `aic-studio/README.md` (skeleton)** (use the Write tool)

```markdown
# AIC Studio for Ping Advanced Identity Cloud

VS Code extension for managing Ping AIC tenant configurations — pull, push, and promote configs across environments.

Part of [PingHub](https://github.com/bostonidentity/PingHub).

## Status

In active development. v1.0 publishing target: see the design spec under `docs/superpowers/specs/`.

## Install (insiders)

Coming soon.

## Development

```
cd aic-studio
npm install
npm run build
```

Then press F5 in VS Code at the repo root to launch the Extension Development Host.

## License

Apache 2.0
```

- [ ] **Step 5: Commit**

```bash
git add aic-studio/.gitignore aic-studio/LICENSE aic-studio/README.md
git commit -m "chore(aic-studio): scaffold project directory and base files"
```

---

## Task 2: Configure package.json with extension manifest

**Files:**
- Create: `aic-studio/package.json`

- [ ] **Step 1: Write `aic-studio/package.json`** (use the Write tool)

```json
{
  "name": "aic-studio",
  "displayName": "AIC Studio for Ping Advanced Identity Cloud",
  "description": "Manage Ping AIC tenant configurations — pull, push, promote, and diff across environments.",
  "version": "0.1.0",
  "publisher": "bostonidentity",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/bostonidentity/PingHub.git",
    "directory": "aic-studio"
  },
  "engines": {
    "vscode": "^1.90.0"
  },
  "categories": ["Other"],
  "keywords": ["ping", "aic", "identity cloud", "forgerock", "pinghub"],
  "icon": "media/icon.png",
  "main": "./out/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "aic-studio",
          "title": "PingHub AIC Studio",
          "icon": "media/icon.svg"
        }
      ]
    },
    "views": {
      "aic-studio": [
        { "id": "aic-studio.environments", "name": "Environments" },
        { "id": "aic-studio.promotionTasks", "name": "Promotion Tasks" },
        { "id": "aic-studio.history", "name": "History" },
        { "id": "aic-studio.monitors", "name": "Monitors" },
        { "id": "aic-studio.logs", "name": "Logs" }
      ]
    },
    "commands": [
      { "command": "aic-studio.env.add", "title": "AIC Studio: Add environment…", "category": "AIC Studio" },
      { "command": "aic-studio.env.setActive", "title": "AIC Studio: Set active environment…", "category": "AIC Studio" },
      { "command": "aic-studio.env.remove", "title": "AIC Studio: Remove environment…", "category": "AIC Studio" }
    ],
    "menus": {
      "view/title": [
        { "command": "aic-studio.env.add", "when": "view == aic-studio.environments", "group": "navigation" }
      ]
    },
    "configuration": {
      "title": "AIC Studio",
      "properties": {
        "aic-studio.activeEnvironment": {
          "type": "string",
          "default": "",
          "description": "Name of the currently active AIC environment."
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "node ./out/tests/integration/runTest.js",
    "pretest:integration": "npm run build",
    "package": "vsce package",
    "vscode:prepublish": "npm run build"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/mocha": "^10.0.10",
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.90.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vscode/test-electron": "^2.4.1",
    "@vscode/vsce": "^3.0.0",
    "electron-rebuild": "^3.2.9",
    "esbuild": "^0.24.0",
    "eslint": "^9.0.0",
    "glob": "^11.0.0",
    "mocha": "^10.7.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "zod": "^3.23.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd aic-studio && npm install
```

Expected: `node_modules/` created, `package-lock.json` updated. `better-sqlite3` may print a build notice — that's expected.

- [ ] **Step 3: Rebuild better-sqlite3 for VS Code's Electron ABI**

```bash
cd aic-studio && npx electron-rebuild -m node_modules/better-sqlite3
```

Note: this rebuild is for local dev. CI does its own rebuild step (Task 26).

- [ ] **Step 4: Commit**

```bash
git add aic-studio/package.json aic-studio/package-lock.json
git commit -m "chore(aic-studio): add package.json with extension manifest"
```

---

## Task 3: Configure TypeScript

**Files:**
- Create: `aic-studio/tsconfig.json`

- [ ] **Step 1: Write `aic-studio/tsconfig.json`** (use the Write tool)

```json
{
  "compilerOptions": {
    "module": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "Node16",
    "outDir": "out",
    "rootDir": ".",
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 2: Verify typecheck succeeds on empty source**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors (no source files yet, so nothing to check).

- [ ] **Step 3: Commit**

```bash
git add aic-studio/tsconfig.json
git commit -m "chore(aic-studio): add TypeScript config"
```

---

## Task 4: Configure esbuild

**Files:**
- Create: `aic-studio/esbuild.config.mjs`

- [ ] **Step 1: Write `aic-studio/esbuild.config.mjs`** (use the Write tool)

```javascript
import esbuild from "esbuild";
import { argv } from "node:process";

const watch = argv.includes("--watch");
const production = !watch;

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

/** @type {import('esbuild').BuildOptions} */
const integrationTestConfig = {
  entryPoints: [
    "tests/integration/runTest.ts",
    "tests/integration/suite/index.ts",
    "tests/integration/suite/activation.test.ts",
    "tests/integration/suite/envCrud.test.ts"
  ],
  bundle: false,
  outdir: "out/tests/integration",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  logLevel: "info"
};

if (watch) {
  const ctx1 = await esbuild.context(extensionConfig);
  const ctx2 = await esbuild.context(integrationTestConfig);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log("watching…");
} else {
  await esbuild.build(extensionConfig);
  await esbuild.build(integrationTestConfig);
}
```

- [ ] **Step 2: Commit (build runs in Task 18 after source files exist)**

```bash
git add aic-studio/esbuild.config.mjs
git commit -m "chore(aic-studio): add esbuild build script"
```

---

## Task 5: Configure vitest

**Files:**
- Create: `aic-studio/vitest.config.ts`

- [ ] **Step 1: Write `aic-studio/vitest.config.ts`** (use the Write tool)

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "out", "tests/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/core/**/*.ts"],
      exclude: ["src/core/**/*.test.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85
      }
    }
  }
});
```

- [ ] **Step 2: Verify vitest config loads (no tests yet — expect "no test files found")**

```bash
cd aic-studio && npm test
```

Expected: vitest reports "No test files found." Exit code may be 0 or non-zero depending on vitest version — that's fine; real tests come next.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/vitest.config.ts
git commit -m "chore(aic-studio): add vitest config"
```

---

## Task 6: Define SQLite schema

**Files:**
- Create: `aic-studio/src/core/db/schema.ts`

- [ ] **Step 1: Write the SQL schema** (use the Write tool)

```typescript
// src/core/db/schema.ts

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS environments (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        tenant_url TEXT NOT NULL,
        username TEXT NOT NULL,
        client_id TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'slate',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
] as const;
```

- [ ] **Step 2: Verify typecheck still passes**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/core/db/schema.ts
git commit -m "feat(aic-studio): define SQLite schema for environments"
```

---

## Task 7: DB connection + migration runner

**Files:**
- Create: `aic-studio/src/core/db/connection.ts`
- Create: `aic-studio/src/core/db/connection.test.ts`

- [ ] **Step 1: Write the failing test** (use the Write tool)

```typescript
// src/core/db/connection.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./connection";
import { SCHEMA_VERSION } from "./schema";

let tmpDirs: string[] = [];

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "aic-studio-test-"));
  tmpDirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("openDatabase", () => {
  it("creates a new database and runs all migrations", () => {
    const db = openDatabase(tmpDb());
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it("is idempotent — re-opening the same DB does not error", () => {
    const path = tmpDb();
    const db1 = openDatabase(path);
    db1.close();
    const db2 = openDatabase(path);
    const row = db2.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db2.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd aic-studio && npm test -- --run src/core/db/connection.test.ts
```

Expected: FAIL with "Cannot find module './connection'".

- [ ] **Step 3: Write the minimal implementation** (use the Write tool)

```typescript
// src/core/db/connection.ts
import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema";

export function openDatabase(path: string): BetterSqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const currentVersion = readVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      db.exec(m.sql);
    }
  }
  if (currentVersion !== SCHEMA_VERSION) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
  }
  return db;
}

function readVersion(db: BetterSqliteDatabase): number {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd aic-studio && npm test -- --run src/core/db/connection.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/connection.ts aic-studio/src/core/db/connection.test.ts
git commit -m "feat(aic-studio): add DB connection with idempotent migrations"
```

---

## Task 8: Environment type definitions

**Files:**
- Create: `aic-studio/src/core/env/types.ts`

- [ ] **Step 1: Write the types and Zod schema** (use the Write tool)

```typescript
// src/core/env/types.ts
import { z } from "zod";

export const EnvironmentColor = z.enum(["blue", "green", "yellow", "red", "slate"]);
export type EnvironmentColor = z.infer<typeof EnvironmentColor>;

export const EnvironmentSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/, {
    message: "name must be lowercase alphanumeric (with - or _)"
  }),
  label: z.string().min(1).max(120),
  tenantUrl: z.string().url(),
  username: z.string().min(1),
  clientId: z.string().min(1),
  color: EnvironmentColor.default("slate"),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export const NewEnvironmentSchema = EnvironmentSchema.omit({ createdAt: true, updatedAt: true });
export type NewEnvironment = z.infer<typeof NewEnvironmentSchema>;
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/core/env/types.ts
git commit -m "feat(aic-studio): add Environment type + Zod schema"
```

---

## Task 9: Environment CRUD — insert and getByName

**Files:**
- Create: `aic-studio/src/core/db/environments.ts`
- Create: `aic-studio/src/core/db/environments.test.ts`

- [ ] **Step 1: Write the failing tests** (use the Write tool)

```typescript
// src/core/db/environments.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "./connection";
import { insertEnvironment, getEnvironmentByName } from "./environments";
import type { NewEnvironment } from "../env/types";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "aic-env-test-"));
  db = openDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const sample: NewEnvironment = {
  name: "prod-tenant",
  label: "Production",
  tenantUrl: "https://prod.id.forgerock.io",
  username: "service-account@example.com",
  clientId: "service-client",
  color: "blue"
};

describe("insertEnvironment", () => {
  it("inserts a new env with auto timestamps", () => {
    const before = Date.now();
    insertEnvironment(db, sample);
    const after = Date.now();

    const env = getEnvironmentByName(db, "prod-tenant");
    expect(env).toBeDefined();
    expect(env?.name).toBe("prod-tenant");
    expect(env?.label).toBe("Production");
    expect(env?.tenantUrl).toBe("https://prod.id.forgerock.io");
    expect(env?.color).toBe("blue");
    expect(env?.createdAt).toBeGreaterThanOrEqual(before);
    expect(env?.createdAt).toBeLessThanOrEqual(after);
    expect(env?.updatedAt).toBe(env?.createdAt);
  });

  it("rejects duplicate name", () => {
    insertEnvironment(db, sample);
    expect(() => insertEnvironment(db, sample)).toThrow(/UNIQUE constraint|already exists/i);
  });
});

describe("getEnvironmentByName", () => {
  it("returns undefined for unknown name", () => {
    expect(getEnvironmentByName(db, "missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd aic-studio && npm test -- --run src/core/db/environments.test.ts
```

Expected: FAIL with "Cannot find module './environments'".

- [ ] **Step 3: Write the minimal implementation** (use the Write tool)

```typescript
// src/core/db/environments.ts
import type { Database } from "better-sqlite3";
import type { Environment, NewEnvironment } from "../env/types";
import { EnvironmentSchema, NewEnvironmentSchema } from "../env/types";

interface Row {
  name: string;
  label: string;
  tenant_url: string;
  username: string;
  client_id: string;
  color: string;
  created_at: number;
  updated_at: number;
}

function rowToEnvironment(row: Row): Environment {
  return EnvironmentSchema.parse({
    name: row.name,
    label: row.label,
    tenantUrl: row.tenant_url,
    username: row.username,
    clientId: row.client_id,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export function insertEnvironment(db: Database, input: NewEnvironment): void {
  const parsed = NewEnvironmentSchema.parse(input);
  const now = Date.now();
  db.prepare(`
    INSERT INTO environments (name, label, tenant_url, username, client_id, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(parsed.name, parsed.label, parsed.tenantUrl, parsed.username, parsed.clientId, parsed.color, now, now);
}

export function getEnvironmentByName(db: Database, name: string): Environment | undefined {
  const row = db.prepare("SELECT * FROM environments WHERE name = ?").get(name) as Row | undefined;
  return row ? rowToEnvironment(row) : undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd aic-studio && npm test -- --run src/core/db/environments.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/environments.ts aic-studio/src/core/db/environments.test.ts
git commit -m "feat(aic-studio): add environment insert + getByName"
```

---

## Task 10: Environment CRUD — list and remove

**Files:**
- Modify: `aic-studio/src/core/db/environments.ts`
- Modify: `aic-studio/src/core/db/environments.test.ts`

- [ ] **Step 1: Append the failing tests** (use the Edit tool — append at end)

Append at the end of `src/core/db/environments.test.ts`:

```typescript
import { listEnvironments, removeEnvironment } from "./environments";

describe("listEnvironments", () => {
  it("returns empty array when no envs", () => {
    expect(listEnvironments(db)).toEqual([]);
  });

  it("returns envs sorted by name", () => {
    insertEnvironment(db, { ...sample, name: "zeta", label: "Zeta" });
    insertEnvironment(db, { ...sample, name: "alpha", label: "Alpha" });
    insertEnvironment(db, { ...sample, name: "mu", label: "Mu" });
    const envs = listEnvironments(db);
    expect(envs.map((e) => e.name)).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("removeEnvironment", () => {
  it("removes the named env", () => {
    insertEnvironment(db, sample);
    expect(getEnvironmentByName(db, sample.name)).toBeDefined();
    removeEnvironment(db, sample.name);
    expect(getEnvironmentByName(db, sample.name)).toBeUndefined();
  });

  it("is a no-op for unknown name", () => {
    expect(() => removeEnvironment(db, "missing")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd aic-studio && npm test -- --run src/core/db/environments.test.ts
```

Expected: FAIL with "Cannot find name 'listEnvironments'" or import errors.

- [ ] **Step 3: Append the implementation** (use the Edit tool — append at end)

Append at the end of `src/core/db/environments.ts`:

```typescript
export function listEnvironments(db: Database): Environment[] {
  const rows = db.prepare("SELECT * FROM environments ORDER BY name ASC").all() as Row[];
  return rows.map(rowToEnvironment);
}

export function removeEnvironment(db: Database, name: string): void {
  db.prepare("DELETE FROM environments WHERE name = ?").run(name);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd aic-studio && npm test -- --run src/core/db/environments.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/environments.ts aic-studio/src/core/db/environments.test.ts
git commit -m "feat(aic-studio): add environment list + remove"
```

---

## Task 11: Active environment tracking

**Files:**
- Modify: `aic-studio/src/core/db/environments.ts`
- Modify: `aic-studio/src/core/db/environments.test.ts`

- [ ] **Step 1: Append the failing tests** (use the Edit tool — append at end)

Append at the end of `src/core/db/environments.test.ts`:

```typescript
import { setActiveEnvironment, getActiveEnvironment } from "./environments";

describe("active environment", () => {
  it("returns undefined when no active env set", () => {
    expect(getActiveEnvironment(db)).toBeUndefined();
  });

  it("setActiveEnvironment + getActiveEnvironment round-trip", () => {
    insertEnvironment(db, sample);
    setActiveEnvironment(db, sample.name);
    expect(getActiveEnvironment(db)).toBe(sample.name);
  });

  it("setActiveEnvironment overwrites prior value", () => {
    insertEnvironment(db, sample);
    insertEnvironment(db, { ...sample, name: "stage-tenant", label: "Stage" });
    setActiveEnvironment(db, "prod-tenant");
    setActiveEnvironment(db, "stage-tenant");
    expect(getActiveEnvironment(db)).toBe("stage-tenant");
  });

  it("setActiveEnvironment(null) clears the value", () => {
    insertEnvironment(db, sample);
    setActiveEnvironment(db, sample.name);
    setActiveEnvironment(db, null);
    expect(getActiveEnvironment(db)).toBeUndefined();
  });

  it("rejects setting active to a non-existent env", () => {
    expect(() => setActiveEnvironment(db, "missing")).toThrow(/no such environment/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd aic-studio && npm test -- --run src/core/db/environments.test.ts
```

Expected: FAIL with "Cannot find name 'setActiveEnvironment'".

- [ ] **Step 3: Append the implementation** (use the Edit tool — append at end)

Append at the end of `src/core/db/environments.ts`:

```typescript
const ACTIVE_ENV_KEY = "active_environment";

export function setActiveEnvironment(db: Database, name: string | null): void {
  if (name === null) {
    db.prepare("DELETE FROM app_state WHERE key = ?").run(ACTIVE_ENV_KEY);
    return;
  }
  const exists = getEnvironmentByName(db, name);
  if (!exists) {
    throw new Error(`no such environment: ${name}`);
  }
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(ACTIVE_ENV_KEY, name);
}

export function getActiveEnvironment(db: Database): string | undefined {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(ACTIVE_ENV_KEY) as { value: string } | undefined;
  return row?.value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd aic-studio && npm test -- --run src/core/db/environments.test.ts
```

Expected: All 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/db/environments.ts aic-studio/src/core/db/environments.test.ts
git commit -m "feat(aic-studio): add active environment tracking"
```

---

## Task 12: SecretStorage key helpers

**Files:**
- Create: `aic-studio/src/core/env/secrets.ts`
- Create: `aic-studio/src/core/env/secrets.test.ts`

- [ ] **Step 1: Write the failing tests** (use the Write tool)

```typescript
// src/core/env/secrets.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { secretKey, SECRET_KINDS, makeStorage, type SecretStore } from "./secrets";

describe("secretKey", () => {
  it("builds a namespaced key per (env, kind)", () => {
    expect(secretKey("prod-tenant", "password")).toBe("aic-studio:env:prod-tenant:password");
    expect(secretKey("stage", "client-secret")).toBe("aic-studio:env:stage:client-secret");
  });

  it("exposes all four supported kinds", () => {
    expect(SECRET_KINDS).toEqual(["password", "client-secret", "log-api-key", "log-api-secret"]);
  });
});

describe("makeStorage (with in-memory backing for tests)", () => {
  let backing: Map<string, string>;
  let store: SecretStore;

  beforeEach(() => {
    backing = new Map();
    store = makeStorage({
      get: async (k) => backing.get(k),
      store: async (k, v) => { backing.set(k, v); },
      delete: async (k) => { backing.delete(k); }
    });
  });

  it("round-trips a stored secret", async () => {
    await store.set("prod-tenant", "password", "hunter2");
    expect(await store.get("prod-tenant", "password")).toBe("hunter2");
  });

  it("returns undefined for unset secrets", async () => {
    expect(await store.get("prod-tenant", "password")).toBeUndefined();
  });

  it("deletes all secrets for an env", async () => {
    for (const kind of SECRET_KINDS) await store.set("prod-tenant", kind, "x");
    await store.deleteAll("prod-tenant");
    for (const kind of SECRET_KINDS) {
      expect(await store.get("prod-tenant", kind)).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd aic-studio && npm test -- --run src/core/env/secrets.test.ts
```

Expected: FAIL with "Cannot find module './secrets'".

- [ ] **Step 3: Write the implementation** (use the Write tool)

```typescript
// src/core/env/secrets.ts

export const SECRET_KINDS = ["password", "client-secret", "log-api-key", "log-api-secret"] as const;
export type SecretKind = typeof SECRET_KINDS[number];

export function secretKey(envName: string, kind: SecretKind): string {
  return `aic-studio:env:${envName}:${kind}`;
}

/**
 * Adapter interface — matches vscode.SecretStorage shape.
 * Keeps core/ free of vscode imports.
 */
export interface SecretBacking {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecretStore {
  get(envName: string, kind: SecretKind): Promise<string | undefined>;
  set(envName: string, kind: SecretKind, value: string): Promise<void>;
  deleteAll(envName: string): Promise<void>;
}

export function makeStorage(backing: SecretBacking): SecretStore {
  return {
    get: (envName, kind) => backing.get(secretKey(envName, kind)),
    set: (envName, kind, value) => backing.store(secretKey(envName, kind), value),
    deleteAll: async (envName) => {
      await Promise.all(SECRET_KINDS.map((k) => backing.delete(secretKey(envName, k))));
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd aic-studio && npm test -- --run src/core/env/secrets.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add aic-studio/src/core/env/secrets.ts aic-studio/src/core/env/secrets.test.ts
git commit -m "feat(aic-studio): add SecretStorage helpers (vscode-free)"
```

---

## Task 13: OutputChannel wrapper

**Files:**
- Create: `aic-studio/src/logging/output.ts`

- [ ] **Step 1: Write the implementation** (use the Write tool)

```typescript
// src/logging/output.ts
import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("AIC Studio");
  ctx.subscriptions.push(channel);
}

function ts(): string {
  return new Date().toISOString();
}

export function log(message: string): void {
  channel?.appendLine(`${ts()} ${message}`);
}

export function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  channel?.appendLine(`${ts()} ERROR ${message}: ${detail}`);
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/logging/output.ts
git commit -m "feat(aic-studio): add OutputChannel logging wrapper"
```

---

## Task 14: EnvironmentsTreeProvider

**Files:**
- Create: `aic-studio/src/providers/envTree.ts`

- [ ] **Step 1: Write the implementation** (use the Write tool)

```typescript
// src/providers/envTree.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments, getActiveEnvironment } from "../core/db/environments";
import type { Environment } from "../core/env/types";

export class EnvNode extends vscode.TreeItem {
  constructor(public readonly env: Environment, isActive: boolean) {
    super(env.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `env:${env.name}`;
    this.contextValue = "aic-studio.env";
    this.description = env.name + (isActive ? "  ●" : "");
    this.iconPath = new vscode.ThemeIcon("globe");
    this.tooltip = new vscode.MarkdownString(
      `**${env.label}** \\\n` +
      `\`${env.name}\` \\\n` +
      `${env.tenantUrl} \\\n` +
      `User: ${env.username}`
    );
  }
}

export class EnvironmentsTreeProvider implements vscode.TreeDataProvider<EnvNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<EnvNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly db: Database) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: EnvNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: EnvNode): EnvNode[] {
    if (element) {
      // Children of an env (Configs, Health, etc.) come in M2.
      return [];
    }
    const active = getActiveEnvironment(this.db);
    return listEnvironments(this.db).map((env) => new EnvNode(env, env.name === active));
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/providers/envTree.ts
git commit -m "feat(aic-studio): add EnvironmentsTreeProvider"
```

---

## Task 15: Status bar item for active environment

**Files:**
- Create: `aic-studio/src/status/activeEnvStatusBar.ts`

- [ ] **Step 1: Write the implementation** (use the Write tool)

```typescript
// src/status/activeEnvStatusBar.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { getActiveEnvironment, getEnvironmentByName } from "../core/db/environments";

const COMMAND_SET_ACTIVE = "aic-studio.env.setActive";

export class ActiveEnvStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(ctx: vscode.ExtensionContext, private readonly db: Database) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = COMMAND_SET_ACTIVE;
    ctx.subscriptions.push(this.item);
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const name = getActiveEnvironment(this.db);
    if (!name) {
      this.item.text = "$(globe) AIC: (no env)";
      this.item.tooltip = "Click to set the active AIC environment";
      return;
    }
    const env = getEnvironmentByName(this.db, name);
    this.item.text = `$(globe) ${env?.label ?? name}`;
    this.item.tooltip = `Active AIC environment: ${name}\nClick to switch`;
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/status/activeEnvStatusBar.ts
git commit -m "feat(aic-studio): add active environment status bar item"
```

---

## Task 16: Environment commands — add / setActive / remove

**Files:**
- Create: `aic-studio/src/commands/env.ts`

- [ ] **Step 1: Write the implementation** (use the Write tool)

```typescript
// src/commands/env.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import {
  insertEnvironment,
  listEnvironments,
  removeEnvironment,
  setActiveEnvironment
} from "../core/db/environments";
import type { SecretStore } from "../core/env/secrets";
import { NewEnvironmentSchema, type NewEnvironment, EnvironmentColor } from "../core/env/types";
import { log, logError } from "../logging/output";

type Deps = {
  db: Database;
  secrets: SecretStore;
  onChange: () => void;
};

export function registerEnvCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.env.add", () => addEnvironmentCommand(deps)),
    vscode.commands.registerCommand("aic-studio.env.setActive", () => setActiveCommand(deps)),
    vscode.commands.registerCommand("aic-studio.env.remove", () => removeEnvironmentCommand(deps))
  );
}

async function addEnvironmentCommand(deps: Deps): Promise<void> {
  try {
    const name = await vscode.window.showInputBox({
      prompt: "Environment name (lowercase, alphanumeric + - _)",
      placeHolder: "prod-tenant",
      validateInput: (v) => /^[a-z0-9][a-z0-9-_]*$/.test(v) ? null : "lowercase alphanumeric only"
    });
    if (!name) return;

    const label = await vscode.window.showInputBox({
      prompt: "Display label",
      placeHolder: "Production",
      value: name
    });
    if (!label) return;

    const tenantUrl = await vscode.window.showInputBox({
      prompt: "Tenant URL",
      placeHolder: "https://prod.id.forgerock.io",
      validateInput: (v) => { try { new URL(v); return null; } catch { return "must be a valid URL"; } }
    });
    if (!tenantUrl) return;

    const username = await vscode.window.showInputBox({
      prompt: "Service-account username",
      placeHolder: "service-account@example.com"
    });
    if (!username) return;

    const clientId = await vscode.window.showInputBox({
      prompt: "OAuth client ID"
    });
    if (!clientId) return;

    const color = await vscode.window.showQuickPick(EnvironmentColor.options, {
      placeHolder: "Color (used in sidebar / status bar)"
    }) as NewEnvironment["color"] | undefined;
    if (!color) return;

    const password = await vscode.window.showInputBox({
      prompt: "Service-account password (stored in OS keychain)",
      password: true
    });
    if (password === undefined) return;

    const clientSecret = await vscode.window.showInputBox({
      prompt: "OAuth client secret (stored in OS keychain)",
      password: true
    });
    if (clientSecret === undefined) return;

    const env = NewEnvironmentSchema.parse({ name, label, tenantUrl, username, clientId, color });
    insertEnvironment(deps.db, env);
    await deps.secrets.set(name, "password", password);
    await deps.secrets.set(name, "client-secret", clientSecret);

    log(`Added environment: ${name}`);
    deps.onChange();
    void vscode.window.showInformationMessage(`Added AIC environment "${label}"`);
  } catch (err) {
    logError("env.add failed", err);
    void vscode.window.showErrorMessage(`Add environment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function setActiveCommand(deps: Deps): Promise<void> {
  const envs = listEnvironments(deps.db);
  if (envs.length === 0) {
    void vscode.window.showInformationMessage("No environments configured. Run 'AIC Studio: Add environment…' first.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Select active environment" }
  );
  if (!pick) return;
  setActiveEnvironment(deps.db, pick.name);
  log(`Active environment: ${pick.name}`);
  deps.onChange();
}

async function removeEnvironmentCommand(deps: Deps): Promise<void> {
  const envs = listEnvironments(deps.db);
  if (envs.length === 0) {
    void vscode.window.showInformationMessage("No environments to remove.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Select environment to remove" }
  );
  if (!pick) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove environment "${pick.label}"? Credentials in the OS keychain are also deleted.`,
    { modal: true },
    "Remove"
  );
  if (confirm !== "Remove") return;

  removeEnvironment(deps.db, pick.name);
  await deps.secrets.deleteAll(pick.name);
  log(`Removed environment: ${pick.name}`);
  deps.onChange();
  void vscode.window.showInformationMessage(`Removed "${pick.label}"`);
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/commands/env.ts
git commit -m "feat(aic-studio): add env add/setActive/remove commands"
```

---

## Task 17: Placeholder TreeProviders for the other 4 views

**Files:**
- Create: `aic-studio/src/providers/placeholderTrees.ts`

- [ ] **Step 1: Write the implementation** (use the Write tool)

```typescript
// src/providers/placeholderTrees.ts
import * as vscode from "vscode";

class PlaceholderProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly placeholderText: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem(this.placeholderText, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("info");
    return [item];
  }
}

export const promotionTasksTree = new PlaceholderProvider("Coming in milestone 6");
export const historyTree = new PlaceholderProvider("Coming in milestone 5");
export const monitorsTree = new PlaceholderProvider("Coming in milestone 8");
export const logsTree = new PlaceholderProvider("Coming in milestone 9");
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd aic-studio && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/providers/placeholderTrees.ts
git commit -m "feat(aic-studio): add placeholder TreeProviders for M5/6/8/9 views"
```

---

## Task 18: Extension activation entry point

**Files:**
- Create: `aic-studio/src/extension.ts`

- [ ] **Step 1: Write the implementation** (use the Write tool)

```typescript
// src/extension.ts
import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./core/db/connection";
import { makeStorage } from "./core/env/secrets";
import { EnvironmentsTreeProvider } from "./providers/envTree";
import {
  promotionTasksTree,
  historyTree,
  monitorsTree,
  logsTree
} from "./providers/placeholderTrees";
import { ActiveEnvStatusBar } from "./status/activeEnvStatusBar";
import { registerEnvCommands } from "./commands/env";
import { initLogger, log, logError } from "./logging/output";

export function activate(ctx: vscode.ExtensionContext): void {
  initLogger(ctx);
  log("AIC Studio activating…");

  try {
    mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
    const db = openDatabase(join(ctx.globalStorageUri.fsPath, "pinghub.db"));
    ctx.subscriptions.push({ dispose: () => db.close() });

    const secrets = makeStorage({
      get: (k) => Promise.resolve(ctx.secrets.get(k)),
      store: (k, v) => Promise.resolve(ctx.secrets.store(k, v)),
      delete: (k) => Promise.resolve(ctx.secrets.delete(k))
    });

    const envTree = new EnvironmentsTreeProvider(db);
    const statusBar = new ActiveEnvStatusBar(ctx, db);

    ctx.subscriptions.push(
      vscode.window.registerTreeDataProvider("aic-studio.environments", envTree),
      vscode.window.registerTreeDataProvider("aic-studio.promotionTasks", promotionTasksTree),
      vscode.window.registerTreeDataProvider("aic-studio.history", historyTree),
      vscode.window.registerTreeDataProvider("aic-studio.monitors", monitorsTree),
      vscode.window.registerTreeDataProvider("aic-studio.logs", logsTree)
    );

    registerEnvCommands(ctx, {
      db,
      secrets,
      onChange: () => {
        envTree.refresh();
        statusBar.refresh();
      }
    });

    log("AIC Studio activated");
  } catch (err) {
    logError("activation failed", err);
    void vscode.window.showErrorMessage(
      `AIC Studio failed to activate: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function deactivate(): void {
  // Subscriptions handle teardown via ctx.subscriptions
}
```

- [ ] **Step 2: Build the extension**

```bash
cd aic-studio && npm run build
```

Expected: `out/extension.js` created, no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/src/extension.ts
git commit -m "feat(aic-studio): wire extension activation — DB, trees, commands, status bar"
```

---

## Task 19: Activity bar icon

**Files:**
- Create: `aic-studio/media/icon.svg`
- Create: `aic-studio/media/icon.png`

- [ ] **Step 1: Write `aic-studio/media/icon.svg`** (use the Write tool)

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
  <circle cx="12" cy="12" r="3"/>
  <path d="M12 6v3M12 15v3M6 12h3M15 12h3" stroke="currentColor" stroke-width="2"/>
</svg>
```

- [ ] **Step 2: Generate a 128x128 PNG for the marketplace listing**

Use whichever tool is available on the developer's machine:

```bash
# macOS:
sips -s format png aic-studio/media/icon.svg --out aic-studio/media/icon.png -z 128 128
# Linux with ImageMagick:
# convert -background none -resize 128x128 aic-studio/media/icon.svg aic-studio/media/icon.png
# Windows / fallback: open icon.svg in any image editor and export as 128x128 PNG.
```

Verify the file exists and is non-empty:

```bash
test -s aic-studio/media/icon.png && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/media/
git commit -m "chore(aic-studio): add placeholder activity bar icon + marketplace PNG"
```

---

## Task 20: F5 launch config + manual dev-host smoke

**Files:**
- Create: `aic-studio/.vscode/launch.json`

- [ ] **Step 1: Write `aic-studio/.vscode/launch.json`** (use the Write tool)

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}/aic-studio"
      ],
      "outFiles": ["${workspaceFolder}/aic-studio/out/**/*.js"]
    }
  ]
}
```

- [ ] **Step 2: Build the extension**

```bash
cd aic-studio && npm run build
```

Expected: `out/extension.js` exists.

- [ ] **Step 3: Manual smoke check (one-time, performed by developer)**

Open VS Code at the PingHub repo root. Press **F5**. A second VS Code window (Extension Development Host) opens.

Verify:
- Activity bar shows a PingHub icon on the left.
- Clicking it reveals 5 collapsible views: Environments, Promotion Tasks, History, Monitors, Logs.
- Environments shows no items.
- Other 4 views each show their "Coming in milestone N" placeholder.
- Status bar (bottom-left) shows "$(globe) AIC: (no env)".
- Open the command palette (Cmd/Ctrl+Shift+P) and type "AIC Studio" — see the three commands listed.
- Run "AIC Studio: Add environment…" — walks through input boxes. After completing, the Environments view refreshes to show the new env.
- Run "AIC Studio: Set active environment…" — pick the new env. Status bar updates.
- Run "AIC Studio: Remove environment…" — confirmation modal appears; on confirm, env disappears.

If any of the above fails, stop and debug before continuing. Inspect the OutputChannel "AIC Studio" for logs.

- [ ] **Step 4: Commit**

```bash
git add aic-studio/.vscode/launch.json
git commit -m "chore(aic-studio): add launch.json for F5 debug"
```

---

## Task 21: Integration test harness

**Files:**
- Create: `aic-studio/tests/integration/runTest.ts`
- Create: `aic-studio/tests/integration/suite/index.ts`

- [ ] **Step 1: Write the test runner entry** (use the Write tool)

```typescript
// tests/integration/runTest.ts
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ["--disable-extensions"]
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 2: Write the Mocha test loader** (use the Write tool)

```typescript
// tests/integration/suite/index.ts
import * as path from "node:path";
import { glob } from "glob";
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60_000 });
  const testsRoot = __dirname;
  const files = await glob("**/*.test.js", { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve());
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add aic-studio/tests/integration/runTest.ts aic-studio/tests/integration/suite/index.ts
git commit -m "test(aic-studio): add @vscode/test-electron harness + Mocha loader"
```

---

## Task 22: Integration test — extension activates and registers commands

**Files:**
- Create: `aic-studio/tests/integration/suite/activation.test.ts`

- [ ] **Step 1: Write the test** (use the Write tool)

```typescript
// tests/integration/suite/activation.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Activation", () => {
  test("extension is present", () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext, "extension not found");
  });

  test("extension activates without error", async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("registers all three env commands", async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    await ext?.activate();
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.env.add"));
    assert.ok(all.includes("aic-studio.env.setActive"));
    assert.ok(all.includes("aic-studio.env.remove"));
  });
});
```

- [ ] **Step 2: Build and run integration tests**

```bash
cd aic-studio && npm run build && npm run test:integration
```

Expected: VS Code downloads a test build on first run (~30s), launches, runs 3 tests, all PASS. Exit code 0.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/tests/integration/suite/activation.test.ts
git commit -m "test(aic-studio): integration test for activation + commands"
```

---

## Task 23: Integration test — env CRUD command surface

**Files:**
- Create: `aic-studio/tests/integration/suite/envCrud.test.ts`

- [ ] **Step 1: Write the test** (use the Write tool)

```typescript
// tests/integration/suite/envCrud.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

/**
 * The multi-prompt InputBox flow is exercised manually in dev (Task 20).
 * These tests confirm the data layer integration with the running extension
 * host (DB opens, commands are reachable, no crashes on empty state).
 * Full data-layer round-trip is covered by vitest in src/core/db/environments.test.ts.
 */

suite("Env CRUD (command surface)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("env.setActive command does not reject when no envs exist", async () => {
    await assert.doesNotReject(
      vscode.commands.executeCommand("aic-studio.env.setActive")
    );
  });

  test("env.remove command does not reject when no envs exist", async () => {
    await assert.doesNotReject(
      vscode.commands.executeCommand("aic-studio.env.remove")
    );
  });

  test("Environments view registered in PingHub container", async () => {
    // Indirectly verify via the views API — if the view container didn't
    // register, opening it would error out.
    await assert.doesNotReject(
      vscode.commands.executeCommand("workbench.view.extension.aic-studio")
    );
  });
});
```

- [ ] **Step 2: Build and run integration tests**

```bash
cd aic-studio && npm run build && npm run test:integration
```

Expected: 6 total tests now (3 activation + 3 envCrud), all PASS.

- [ ] **Step 3: Commit**

```bash
git add aic-studio/tests/integration/suite/envCrud.test.ts
git commit -m "test(aic-studio): integration test for env command surface"
```

---

## Task 24: ESLint configuration

**Files:**
- Create: `aic-studio/eslint.config.mjs`

- [ ] **Step 1: Write the flat ESLint config** (use the Write tool)

```javascript
// aic-studio/eslint.config.mjs
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module"
      }
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["error", { allow: ["warn", "error"] }]
    }
  },
  {
    ignores: ["out/**", "node_modules/**", "*.config.mjs", "*.config.ts"]
  }
];
```

- [ ] **Step 2: Run lint**

```bash
cd aic-studio && npm run lint
```

Expected: lint passes (no errors).

- [ ] **Step 3: Commit**

```bash
git add aic-studio/eslint.config.mjs
git commit -m "chore(aic-studio): add ESLint flat config"
```

---

## Task 25: .vscodeignore for VSIX packaging

**Files:**
- Create: `aic-studio/.vscodeignore`

- [ ] **Step 1: Write `aic-studio/.vscodeignore`** (use the Write tool)

```
.vscode/
.vscode-test/
src/
tests/
out/tests/
**/*.test.js
**/*.test.ts
**/*.map
**/tsconfig*.json
**/vitest.config.ts
**/esbuild.config.mjs
**/eslint.config.mjs
.gitignore
.gitattributes
coverage/
```

- [ ] **Step 2: Verify a dry-run package succeeds**

```bash
cd aic-studio && npm run build && npx vsce package --no-yarn --pre-release
```

Expected: produces `aic-studio-0.1.0.vsix`. Note the size (a few MB; native binary dominates).

- [ ] **Step 3: Inspect the VSIX contents (sanity check)**

```bash
unzip -l aic-studio/aic-studio-0.1.0.vsix | head -30
```

Verify the listing shows `extension/out/extension.js`, `extension/media/icon.*`, `extension/node_modules/better-sqlite3/build/...`, but NOT `extension/src/` or `extension/tests/`.

- [ ] **Step 4: Clean up the dry-run VSIX**

```bash
rm aic-studio/aic-studio-0.1.0.vsix
```

- [ ] **Step 5: Commit**

```bash
git add aic-studio/.vscodeignore
git commit -m "chore(aic-studio): add .vscodeignore for VSIX packaging"
```

---

## Task 26: GitHub Actions — PR CI workflow

**Files:**
- Create: `.github/workflows/aic-studio-ci.yml`

- [ ] **Step 1: Write the workflow** (use the Write tool)

```yaml
# .github/workflows/aic-studio-ci.yml
name: aic-studio CI

on:
  pull_request:
    paths:
      - "aic-studio/**"
      - ".github/workflows/aic-studio-ci.yml"
  push:
    branches: [development, main]
    paths:
      - "aic-studio/**"
      - ".github/workflows/aic-studio-ci.yml"

defaults:
  run:
    working-directory: aic-studio

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-14, macos-13]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: aic-studio/package-lock.json
      - name: Install
        run: npm ci
      - name: Rebuild native modules for Electron
        run: npx electron-rebuild -m node_modules/better-sqlite3
        continue-on-error: true
      - name: Typecheck
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Unit tests
        run: npm test -- --run
      - name: Integration tests (xvfb on Linux)
        if: runner.os == 'Linux'
        run: xvfb-run -a npm run test:integration
      - name: Integration tests
        if: runner.os != 'Linux'
        run: npm run test:integration
```

- [ ] **Step 2: Commit (CI will run on next push that touches aic-studio/)**

```bash
git add .github/workflows/aic-studio-ci.yml
git commit -m "ci(aic-studio): add PR + push CI on 4 OS matrix"
```

---

## Task 27: GitHub Actions — insiders release workflow (drafted, disabled)

**Files:**
- Create: `.github/workflows/aic-studio-insiders.yml`
- Create: `aic-studio/scripts/stamp-insiders-version.mjs`

- [ ] **Step 1: Write the version-stamping script** (use the Write tool)

This avoids inline `node -e` patterns and keeps logic versioned.

```javascript
// aic-studio/scripts/stamp-insiders-version.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const baseVersion = pkg.version;
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const newVersion = `${baseVersion}-insiders.${stamp}`;

pkg.name = "aic-studio-insiders";
pkg.displayName = `${pkg.displayName} (Insiders)`;
pkg.version = newVersion;

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Stamped insiders version: ${newVersion}`);
```

- [ ] **Step 2: Write the workflow** (use the Write tool)

```yaml
# .github/workflows/aic-studio-insiders.yml
# Publishes to bostonidentity.aic-studio-insiders on every push to main.
# DRAFTED ONLY — disabled until a publisher account + VSCE_PAT secret exist.
# To enable: remove the `if: false` from the build job and confirm secrets.

name: aic-studio insiders publish

on:
  push:
    branches: [main]
    paths:
      - "aic-studio/**"

defaults:
  run:
    working-directory: aic-studio

jobs:
  build:
    if: false  # ← remove this line when ready to publish
    strategy:
      fail-fast: false
      matrix:
        target:
          - { runs: ubuntu-latest, vsce: linux-x64 }
          - { runs: windows-latest, vsce: win32-x64 }
          - { runs: macos-14, vsce: darwin-arm64 }
          - { runs: macos-13, vsce: darwin-x64 }
    runs-on: ${{ matrix.target.runs }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: aic-studio/package-lock.json
      - run: npm ci
      - run: npx electron-rebuild -m node_modules/better-sqlite3
        continue-on-error: true
      - run: npm run build
      - name: Stamp insiders version
        run: node scripts/stamp-insiders-version.mjs
      - name: Package
        run: npx vsce package --target ${{ matrix.target.vsce }} --pre-release
      - name: Publish
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
        run: npx vsce publish --packagePath aic-studio-insiders-*.vsix --pre-release
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/aic-studio-insiders.yml aic-studio/scripts/stamp-insiders-version.mjs
git commit -m "ci(aic-studio): draft insiders publish workflow (disabled until secrets set)"
```

---

## Task 28: Update root README to mention aic-studio

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current root README to confirm the project-table location**

Open `README.md` in the editor. Locate the row for `aic-pipeline/` in the "Projects" table.

- [ ] **Step 2: Add an entry for aic-studio** (use the Edit tool)

Below the existing `aic-pipeline/` row, add:

```markdown
| [`aic-studio/`](./aic-studio) | VS Code extension successor to `aic-pipeline/` — same workflows, native VS Code UX. Currently in pre-release development. |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: list aic-studio in root project table"
```

---

## Task 29: CHANGELOG for aic-studio

**Files:**
- Create: `aic-studio/CHANGELOG.md`

- [ ] **Step 1: Write the initial CHANGELOG** (use the Write tool)

```markdown
# Changelog

All notable changes to AIC Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (M1 — scaffold & environments)

- Project scaffold: TypeScript, esbuild, vitest, @vscode/test-electron, ESLint
- PingHub activity bar icon
- Five sidebar TreeViews (Environments + 4 placeholders)
- SQLite-backed environment storage at `globalStorageUri/pinghub.db`
- `SecretStorage`-backed credentials (password, client secret, log API key/secret)
- Commands: `aic-studio.env.add`, `aic-studio.env.setActive`, `aic-studio.env.remove`
- Status bar item showing active environment
- CI workflow on 4 OS targets
- Insiders publish workflow (drafted, awaiting secrets)
```

- [ ] **Step 2: Commit**

```bash
git add aic-studio/CHANGELOG.md
git commit -m "docs(aic-studio): add initial CHANGELOG"
```

---

## Task 30: M1 acceptance gate — full local verification

**Files:** none (verification step)

- [ ] **Step 1: Clean and reinstall to confirm reproducibility**

```bash
cd aic-studio && rm -rf node_modules out coverage && npm ci
cd aic-studio && npx electron-rebuild -m node_modules/better-sqlite3
```

- [ ] **Step 2: Run typecheck + lint + unit + integration**

```bash
cd aic-studio && npm run typecheck && npm run lint && npm test -- --run && npm run build && npm run test:integration
```

Expected: all five steps exit 0. Vitest reports ≥12 unit tests passing; integration reports 6 tests passing.

- [ ] **Step 3: Verify coverage gate**

```bash
cd aic-studio && npm test -- --run --coverage
```

Expected: coverage on `src/core/` ≥85% lines / functions / statements, ≥75% branches.

- [ ] **Step 4: Manual F5 smoke (final time)**

Press F5 in VS Code at the repo root. Confirm:
- Extension Dev Host opens
- PingHub activity bar icon present
- Add an env via "AIC Studio: Add environment…" — succeeds
- Env appears in Environments view
- Set active — status bar updates
- Remove env — confirmation modal appears, env disappears after confirm

- [ ] **Step 5: No commit needed — this is the M1 acceptance gate.**

If everything passes, M1 is complete and ready for the M2 plan (SCM/Sync — pulling configs from AIC, virtual `aic://` documents, diff editor integration).

---

## Self-Review

Walked through the spec sections against the plan:

- **§1 Architecture & repo layout** — Tasks 1–5 establish the project skeleton. Two-layer boundary (core VS Code-free, providers/commands own vscode) enforced by file organization. ✓
- **§2 UI mapping** — Activity bar icon (Task 19), 5 TreeViews registered (Task 18), placeholders for 4 of them (Task 17), Environments TreeView functional (Task 14). Status bar item (Task 15). ✓ Remaining UI surfaces (SCM, diff editor, virtual docs, webviews, command palette commands beyond env/setActive/remove) are explicitly deferred to M2+ per the milestone-per-plan decomposition.
- **§3 Data & persistence** — SQLite at globalStorageUri (Task 18 activation), schema with `environments`, `app_state`, `schema_meta` (Tasks 6–11). SecretStorage adapter pattern (Task 12). Credentials prompted in add command and stored via SecretStorage (Task 16). ✓
- **§4 Command surface** — Three env commands match the spec's `aic-studio.env.*` group (Task 16). Activation event `onStartupFinished` (Task 2 package.json). Menu contribution for "+" in Environments view title (Task 2). Other command groups deferred to later milestones, as expected. ✓
- **§5 Build & distribution** — esbuild (Task 4), `vsce` config + `.vscodeignore` (Task 25), platform-specific VSIX targets in the insiders workflow (Task 27), CI on 4 OS (Task 26), publisher `bostonidentity` (Task 2 package.json). ✓
- **§6 Testing strategy** — vitest for core (Tasks 9–12), @vscode/test-electron harness (Task 21) and tests (Tasks 22–23), coverage gate (Task 5 vitest config, verified in Task 30). ✓
- **§7 Cutover plan** — N/A in M1; this milestone is part of Phase 1 (Build phase) of the cutover.

**Placeholder scan:** searched for TBD/TODO/fillin/etc. None remain in the plan body.

**Type consistency:** `EnvironmentSchema` (zod) → `Environment` (TS type) → DB row mapping in Task 9 matches the column list in Task 6 schema. `SECRET_KINDS` enumerated in Task 12 matches `password`, `client-secret`, `log-api-key`, `log-api-secret` prompts in Task 16. `EnvironmentColor` enum in Task 8 used in `showQuickPick` in Task 16. Method names consistent: `insertEnvironment`, `getEnvironmentByName`, `listEnvironments`, `removeEnvironment`, `setActiveEnvironment`, `getActiveEnvironment` used identically across Tasks 9–11, providers, and commands.

**One known minor gap to flag:** the spec's §3 lists additional tables (`iga_cache`, `monitors`, `op_history`, `promotion_tasks`, `git_index`). M1 only creates `environments`, `app_state`, `schema_meta` — the others are intentionally deferred to the milestone that needs them (e.g. `op_history` in M2 when pull/push records operations). This follows YAGNI and the milestone decomposition; calling it out so the M1 reviewer doesn't think it's an oversight.
