# AIC Pipeline — Electron Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing Next.js aic-pipeline app as an Electron desktop application that ships as native installers for macOS arm64, macOS x64, Windows x64, and Linux x64.

**Architecture:** Next.js standalone server runs in-process inside Electron's main process; BrowserWindow renders the existing UI by loading http://127.0.0.1:<random-port>. No subprocess spawning of Next, no external CLI dependencies. Single repo, single CI pipeline.

**Tech Stack:** Electron 33+, electron-builder, @electron/rebuild, get-port, TypeScript, existing Next.js 16 stack.

**Branch:** `aic-pipeline/electron-mvp` branched from `development`.

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-pipeline-electron -b aic-pipeline/electron-mvp development
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-pipeline-electron/aic-pipeline
npm ci
npm test                                  # baseline: 531 passing
```

---

## File Structure

```
aic-pipeline/
  electron/                                       NEW
    main.ts                                       Main process entry
    menu.ts                                       Native menubar
    single-instance.ts                            Single-instance lock
    data-dir.ts                                   Data dir resolution + migration
    data-dir.test.ts                              Unit test
    port.ts                                       Port allocation wrapper
    port.test.ts                                  Unit test
    tsconfig.json                                 CJS, target=node20
  build-resources/                                NEW
    icon.icns, icon.ico, icon.png
    entitlements.mac.plist
  electron-builder.yml                            NEW
  next.config.js                                  MODIFY: output: "standalone"
  package.json                                    MODIFY: add deps + scripts + build refs
  .github/workflows/electron-release.yml          NEW: tag-triggered CI
  CHANGELOG.md                                    MODIFY: v0.3.0 entry
```

---

## M1 — Electron shell + dev mode (~1 day)

### Task 1: Install Electron deps + tsconfig

**Files:** `package.json`, `electron/tsconfig.json`

- [ ] **Step 1:** Add devDependencies:
  ```bash
  npm install --save-dev electron electron-builder @electron/rebuild get-port
  ```

- [ ] **Step 2:** Create `electron/tsconfig.json`:
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "CommonJS",
      "moduleResolution": "node",
      "outDir": "./dist",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "resolveJsonModule": true,
      "types": ["node"]
    },
    "include": ["**/*.ts"],
    "exclude": ["**/*.test.ts", "dist"]
  }
  ```

- [ ] **Step 3:** Add scripts to root `package.json`:
  ```json
  "electron:compile": "tsc -p electron/tsconfig.json",
  "electron:dev": "concurrently -k \"npm run dev\" \"wait-on http://127.0.0.1:3000 && npm run electron:compile && electron electron/dist/main.js --dev\"",
  "electron:rebuild": "electron-rebuild -f -w better-sqlite3",
  "postinstall": "electron-rebuild -f -w better-sqlite3 || true"
  ```
  (`concurrently` and `wait-on` are devDependencies — add them.)

- [ ] **Step 4:** Add `"main": "electron/dist/main.js"` to package.json.

- [ ] **Step 5:** Run `npm install` to install everything. Confirm `electron-rebuild` succeeds for better-sqlite3.

- [ ] **Step 6:** Commit: `chore(electron): add Electron deps + tsconfig`

### Task 2: Data dir resolution (TDD)

**Files:** `electron/data-dir.ts`, `electron/data-dir.test.ts`

- [ ] **Step 1:** Write failing test `electron/data-dir.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { resolveDataDir, detectLegacyDataDir } from "./data-dir";
  import * as path from "node:path";
  import * as os from "node:os";

  describe("resolveDataDir", () => {
    it("honors PINGHUB_DATA_DIR env var", () => {
      expect(resolveDataDir({ envOverride: "/tmp/custom", appUserData: "/ignored" }))
        .toBe("/tmp/custom");
    });

    it("falls back to app.getPath('userData')", () => {
      expect(resolveDataDir({ envOverride: undefined, appUserData: "/foo/PingHub" }))
        .toBe("/foo/PingHub");
    });
  });

  describe("detectLegacyDataDir", () => {
    it("returns undefined when no legacy locations exist", () => {
      expect(detectLegacyDataDir({ home: "/nonexistent-home", cwd: "/nonexistent-cwd" })).toBeUndefined();
    });
    // Add a more sophisticated test that creates a temp dir with .pinghub/ + checks detection.
  });
  ```

- [ ] **Step 2:** Run test → FAIL (module missing).

- [ ] **Step 3:** Implement `electron/data-dir.ts`:
  ```ts
  import * as fs from "node:fs";
  import * as path from "node:path";

  export interface ResolveOptions {
    envOverride?: string;
    appUserData: string;
  }

  export function resolveDataDir(opts: ResolveOptions): string {
    return opts.envOverride?.trim() || opts.appUserData;
  }

  export interface LegacyDetectOptions {
    home: string;
    cwd: string;
  }

  export function detectLegacyDataDir(opts: LegacyDetectOptions): string | undefined {
    const candidates = [
      path.join(opts.home, ".pinghub"),
      path.join(opts.cwd, "environments")
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return undefined;
  }
  ```

- [ ] **Step 4:** Run test → PASS.

- [ ] **Step 5:** Commit: `feat(electron): data dir resolution + legacy detection`

### Task 3: Port allocation wrapper (TDD)

**Files:** `electron/port.ts`, `electron/port.test.ts`

- [ ] **Step 1:** Write failing test:
  ```ts
  import { describe, it, expect } from "vitest";
  import { pickFreePort } from "./port";

  describe("pickFreePort", () => {
    it("returns a port in [1024, 65535]", async () => {
      const p = await pickFreePort();
      expect(p).toBeGreaterThanOrEqual(1024);
      expect(p).toBeLessThanOrEqual(65535);
    });
    it("returns different ports on successive calls", async () => {
      const a = await pickFreePort();
      const b = await pickFreePort();
      expect(a).not.toBe(b);
    });
  });
  ```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3:** Implement `electron/port.ts`:
  ```ts
  import getPort from "get-port";
  export async function pickFreePort(): Promise<number> {
    return await getPort();
  }
  ```

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5:** Commit: `feat(electron): port allocation wrapper`

### Task 4: Main process (dev-mode capable)

**Files:** `electron/main.ts`, `electron/menu.ts`, `electron/single-instance.ts`

- [ ] **Step 1:** Implement `electron/single-instance.ts`:
  ```ts
  import { app, BrowserWindow } from "electron";

  export function enforceSingleInstance(onSecondInstance: () => BrowserWindow | null): boolean {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return false;
    }
    app.on("second-instance", () => {
      const win = onSecondInstance();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    return true;
  }
  ```

- [ ] **Step 2:** Implement `electron/menu.ts` — minimal app menu (defer rich menu to v1.1).

- [ ] **Step 3:** Implement `electron/main.ts`:
  ```ts
  import { app, BrowserWindow } from "electron";
  import * as path from "node:path";
  import * as os from "node:os";
  import { enforceSingleInstance } from "./single-instance";
  import { resolveDataDir, detectLegacyDataDir } from "./data-dir";
  import { pickFreePort } from "./port";

  const isDev = process.argv.includes("--dev");
  let mainWindow: BrowserWindow | null = null;

  function createWindow(url: string): BrowserWindow {
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      title: "PingHub",
      webPreferences: { sandbox: false }
    });
    void mainWindow.loadURL(url);
    mainWindow.on("closed", () => { mainWindow = null; });
    return mainWindow;
  }

  if (!enforceSingleInstance(() => mainWindow)) {
    // app.quit() already called inside enforceSingleInstance
  } else {
    void app.whenReady().then(async () => {
      // Resolve data dir + export to Next.js's lib via env var
      const dataDir = resolveDataDir({
        envOverride: process.env.PINGHUB_DATA_DIR,
        appUserData: app.getPath("userData")
      });
      process.env.PINGHUB_DATA_DIR = dataDir;

      if (isDev) {
        createWindow("http://127.0.0.1:3000");
      } else {
        const port = await pickFreePort();
        // Production: import and start Next standalone server in-process
        const standaloneDir = path.join(process.resourcesPath, "app", ".next", "standalone");
        process.chdir(standaloneDir);
        process.env.HOSTNAME = "127.0.0.1";
        process.env.PORT = String(port);
        require(path.join(standaloneDir, "server.js"));
        createWindow(`http://127.0.0.1:${port}`);
      }
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && !isDev) {
        // Re-open is handled by re-creating window logic — for MVP we keep it simple
      }
    });
  }
  ```

- [ ] **Step 4:** Verify dev flow:
  ```bash
  npm run electron:dev
  ```
  An Electron window should open showing the PingHub UI. Close the window — process should exit cleanly.

- [ ] **Step 5:** Commit: `feat(electron): main process + dev-mode shell`

---

## M2 — Production build wiring (~1 day)

### Task 5: Next.js standalone output

**Files:** `next.config.js`

- [ ] **Step 1:** Modify `next.config.js`:
  ```js
  module.exports = {
    output: "standalone",
    outputFileTracingIncludes: {
      "**/*": ["./src/vendor/**/*"]   // ensure vendored JS is included
    },
    // ... existing config
  };
  ```

- [ ] **Step 2:** Build + verify:
  ```bash
  rm -rf .next
  npm run build
  ls .next/standalone/server.js   # must exist
  ls .next/standalone/src/vendor/fr-config-manager/   # vendored code must be copied
  ```

- [ ] **Step 3:** Commit: `build(electron): enable Next.js standalone output with vendored includes`

### Task 6: Production smoke test of standalone server

- [ ] **Step 1:** Manually:
  ```bash
  cd .next/standalone
  PORT=3456 HOSTNAME=127.0.0.1 PINGHUB_DATA_DIR=/tmp/pinghub-test node server.js &
  curl http://127.0.0.1:3456 | head -5
  ```
  Confirm the standalone server responds and the data dir env var is honored.

- [ ] **Step 2:** If anything fails (most likely cause: vendored code missing or env var not honored), fix the config and re-test.

- [ ] **Step 3:** No commit if no code change. Otherwise: `fix(electron): ensure standalone server honors PINGHUB_DATA_DIR`.

### Task 7: PINGHUB_DATA_DIR plumbing into Next.js

**File:** `aic-pipeline/src/lib/paths.ts` (or wherever `ENVIRONMENTS_DIR` is defined)

- [ ] **Step 1:** Locate the ENVIRONMENTS_DIR constant. Modify to honor `PINGHUB_DATA_DIR`:
  ```ts
  const ROOT = process.env.PINGHUB_DATA_DIR || path.resolve(process.cwd());
  export const ENVIRONMENTS_DIR = path.join(ROOT, "environments");
  export const SNAPSHOTS_DIR = path.join(ROOT, "snapshots");
  // SQLite path similarly
  ```

  (The exact location and shape depends on the current paths module — `grep -rn "ENVIRONMENTS_DIR\s*=" src/lib/`)

- [ ] **Step 2:** Run existing tests to confirm no regression:
  ```bash
  npm test
  ```
  Expect 531 passing.

- [ ] **Step 3:** Commit: `feat(electron): honor PINGHUB_DATA_DIR in paths module`

---

## M3 — Data dir migration (~half day)

### Task 8: First-run migration logic

**Files:** `electron/data-dir.ts`, `electron/main.ts`

- [ ] **Step 1:** Add migration helper to `electron/data-dir.ts`:
  ```ts
  import { dialog } from "electron";

  export interface MigrationDecision {
    action: "migrate" | "use-legacy" | "use-new";
  }

  export async function promptMigration(legacyPath: string, newPath: string): Promise<MigrationDecision> {
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: "PingHub data migration",
      message: "Existing PingHub data found",
      detail: `Found data at:\n  ${legacyPath}\n\nThe new default location is:\n  ${newPath}\n\nWhat would you like to do?`,
      buttons: ["Migrate to new location", "Keep using legacy location", "Use new (don't migrate)"],
      defaultId: 0,
      cancelId: 1
    });
    return { action: response === 0 ? "migrate" : response === 1 ? "use-legacy" : "use-new" };
  }

  export async function migrateData(from: string, to: string): Promise<void> {
    await fs.promises.cp(from, to, { recursive: true });
  }
  ```

  (Unit tests for `migrateData` use temp dirs.)

- [ ] **Step 2:** Wire into `electron/main.ts` before setting `process.env.PINGHUB_DATA_DIR`. Only prompt if (a) legacy exists AND (b) new location is empty.

- [ ] **Step 3:** Test manually: place dummy `~/.pinghub/test.txt`, launch dev, confirm prompt appears, migration succeeds.

- [ ] **Step 4:** Commit: `feat(electron): first-run migration prompt + execution`

---

## M4 — electron-builder config (~1 day)

### Task 9: electron-builder.yml

**File:** `aic-pipeline/electron-builder.yml`

- [ ] **Step 1:** Create:
  ```yaml
  appId: com.bostonidentity.pinghub
  productName: PingHub
  copyright: Copyright © 2026 Boston Identity
  directories:
    output: dist
    buildResources: build-resources
  files:
    - electron/dist/**/*
    - .next/standalone/**/*
    - .next/static/**/*
    - public/**/*
    - package.json
    - "!**/*.{md,test.ts,test.tsx,spec.ts}"
  extraResources:
    - from: .next/static
      to: app/.next/static
    - from: public
      to: app/public
  asar: true
  asarUnpack:
    - node_modules/better-sqlite3/**/*
  mac:
    icon: build-resources/icon.icns
    category: public.app-category.developer-tools
    target:
      - target: dmg
        arch: [arm64, x64]
    hardenedRuntime: true
    entitlements: build-resources/entitlements.mac.plist
    entitlementsInherit: build-resources/entitlements.mac.plist
    gatekeeperAssess: false
  win:
    icon: build-resources/icon.ico
    target:
      - target: nsis
        arch: [x64]
  linux:
    icon: build-resources/icon.png
    target:
      - target: AppImage
        arch: [x64]
    category: Development
  ```

- [ ] **Step 2:** Create minimal `build-resources/entitlements.mac.plist`:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
    <dict>
      <key>com.apple.security.cs.allow-jit</key><true/>
      <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
      <key>com.apple.security.network.client</key><true/>
      <key>com.apple.security.network.server</key><true/>
    </dict>
  </plist>
  ```

- [ ] **Step 3:** Add placeholder icons (build-resources/icon.png 512x512, derive .icns and .ico if possible — if not, use a basic one and refine in v1.1).

- [ ] **Step 4:** Add `electron:build` script:
  ```json
  "electron:build": "npm run build && npm run electron:compile && electron-builder --publish never"
  ```

- [ ] **Step 5:** Run on macOS:
  ```bash
  npm run electron:build
  ls dist/   # expect .dmg files
  ```

- [ ] **Step 6:** Install the .dmg locally, launch, verify the UI loads.

- [ ] **Step 7:** Commit: `build(electron): electron-builder config + macOS dmg`

### Task 10: Verify Windows + Linux builds via CI (or skip locally)

- [ ] **Step 1:** Push to a feature branch and let CI's matrix build all three. If you don't have CI yet, skip — covered by Task 11.

---

## M5 — CI release workflow (~1 day)

### Task 11: GitHub Actions release workflow

**File:** `aic-pipeline/.github/workflows/electron-release.yml`

- [ ] **Step 1:** Create:
  ```yaml
  name: Electron Release

  on:
    push:
      tags: ["v*"]

  jobs:
    build:
      strategy:
        fail-fast: false
        matrix:
          include:
            - { runs: macos-14, name: "macos-arm64" }
            - { runs: macos-13, name: "macos-x64" }
            - { runs: windows-latest, name: "win-x64" }
            - { runs: ubuntu-latest, name: "linux-x64" }
      runs-on: ${{ matrix.runs }}
      defaults:
        run:
          working-directory: aic-pipeline
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: "20", cache: npm, cache-dependency-path: aic-pipeline/package-lock.json }
        - run: npm ci
        - run: npm run electron:build
        - uses: actions/upload-artifact@v4
          with:
            name: pinghub-${{ matrix.name }}
            path: aic-pipeline/dist/*.{dmg,exe,AppImage,zip,yml}

    release:
      needs: build
      runs-on: ubuntu-latest
      permissions:
        contents: write
      steps:
        - uses: actions/checkout@v4
        - uses: actions/download-artifact@v4
          with: { path: artifacts/ }
        - run: ls -R artifacts/
        - uses: softprops/action-gh-release@v2
          with:
            files: artifacts/*/*
            draft: true
            generate_release_notes: true
  ```

- [ ] **Step 2:** Commit: `ci(electron): tag-triggered release workflow (mac+win+linux)`

- [ ] **Step 3:** Test by pushing a pre-release tag like `v0.3.0-rc.1` to a feature branch (do NOT push to main yet). Verify all 4 matrix jobs pass + artifacts uploaded.

---

## M6 — CHANGELOG + acceptance gate

### Task 12: Update CHANGELOG

**File:** `aic-pipeline/CHANGELOG.md` (or root README if no CHANGELOG yet)

- [ ] **Step 1:** Add `## [0.3.0] - 2026-05-XX` section:
  ```markdown
  ### Added
  - Electron desktop wrapper: shippable as .dmg / .exe / .AppImage installers
  - Per-OS auto-built installers via GitHub Actions on tag push
  - First-run data migration from legacy ~/.pinghub or cwd locations
  - PINGHUB_DATA_DIR env var honored by paths module
  ```

- [ ] **Step 2:** Commit.

### Task 13: Manual acceptance gate

- [ ] **Step 1:** From a fresh shell, run all of:
  ```bash
  cd aic-pipeline
  npm ci
  npm test                              # baseline 531 pass
  npm run build                         # next build clean
  npm run electron:build                # local installer build
  ls dist/                              # confirm .dmg / .AppImage / .exe present
  ```

- [ ] **Step 2:** Install the local .dmg / .AppImage / .exe.

- [ ] **Step 3:** Launch the installed app. Verify:
  - Window opens with PingHub UI
  - Adding an environment works
  - Pull / push / promote work (against a real AIC sandbox if available)
  - Data persists across app restarts
  - File menu has Quit / About

- [ ] **Step 4:** If all green, this milestone is complete.

---

## Self-Review

**Spec coverage:**
- §2 architecture → Tasks 4-6 ✓
- §3 layout → Tasks 1, 4, 9 ✓
- §4 build pipeline → Tasks 5, 9, 11 ✓
- §5 data dir → Tasks 2, 7, 8 ✓
- §6 first-run → Task 8 ✓
- §7 signing (deferred) → Out of scope, called out ✓
- §10 acceptance criteria → Task 13 ✓
- §11 risks → Mitigations baked into Tasks 1 (postinstall rebuild), 5 (outputFileTracingIncludes), 4 (single-instance), 3 (get-port) ✓

**Placeholder scan:** Three concrete pieces deferred to implementer judgment:
- Task 7: "exact location depends on current paths module — grep it" — explicit grep command given
- Task 9 Step 3: "use a basic icon" — acceptable for MVP
- Task 10: optional, skips cleanly if CI not ready

**Type consistency:** ResolveOptions/LegacyDetectOptions/MigrationDecision are all consistent across data-dir.ts and main.ts callers.

Plan ready.
