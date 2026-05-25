# AIC Pipeline — Electron Desktop Wrapper (Design Spec)

**Date:** 2026-05-24
**Scope:** Wrap the existing Next.js `aic-pipeline` app as a native desktop application via Electron. Ship installers for macOS (arm64 + x64), Windows x64, and Linux x64. Zero external CLI dependencies.
**Outcome target:** A `git tag v0.3.0` produces downloadable installers; users install + launch + use without any prerequisites.

---

## 1. Motivation

The Next.js app currently requires a developer-grade install (clone → `npm install` → build → `npm start` → open browser). Target users are IAM/devops engineers, not necessarily Node developers. The goal is one-step install with a native-app feel that preserves every feature of the existing web app.

Why Electron over alternatives:
- **vs Tauri:** Tauri's smaller footprint comes at the cost of Rust toolchain dependency and rewriting `child_process.spawn` paths. The Next.js app uses Node-only features (better-sqlite3, in-process `vendor/fr-config-manager`, file I/O) that Electron supports natively.
- **vs Docker:** Requires Docker installed on user's machine — high friction for non-devs; networking/permissions gotchas on Windows.
- **vs single binary (pkg/bun):** Next.js standalone + better-sqlite3 native module + recharts dynamic imports have rough edges; testing showed flakiness.
- **vs install script:** Still requires terminal use + Node detection + corp-network compatibility issues.

Electron gives: native installer per OS, Node main process (so all existing code works), Chromium renderer (so all existing UI works), auto-update via `electron-updater`, OS keychain access for secrets.

---

## 2. Architecture

**One process model: Next.js as an in-process server inside Electron's main process.**

```
Electron App
├── Main process (Node.js)
│   ├── Next.js standalone server (in-process import — not subprocess)
│   │   ├── All /api/* routes (existing)
│   │   ├── SQLite via better-sqlite3 (existing)
│   │   ├── Snapshot file I/O (existing)
│   │   └── In-process fr-config-manager / frodo / iga-api (existing vendored code)
│   ├── App lifecycle (single-instance lock, menu, dock icon, tray)
│   ├── Data dir management (app.getPath('userData'))
│   └── Optional: auto-updater
└── BrowserWindow (Chromium renderer)
    └── Loads http://127.0.0.1:<port> → renders the existing Next.js UI
```

Key decisions:
- **In-process Next.js server.** Avoid spawning `npm run start` as a subprocess. Use `next()` programmatically OR load the standalone `server.js`. Same memory space as Electron main, no IPC overhead, no port collision since we auto-pick a free port.
- **localhost-only binding (127.0.0.1).** Server is not externally accessible; only the bundled Chromium window can hit it.
- **Random free port per launch.** Use `get-port` (or equivalent) so multiple concurrent app instances don't collide.
- **No preload bridge required.** The renderer talks to the local Next.js server via HTTP exactly as today's browser tab does. Standard web fetch / cookies / no IPC.

---

## 3. Project layout

```
aic-pipeline/
├── electron/                       NEW
│   ├── main.ts                     Main process entry: starts Next, opens window
│   ├── menu.ts                     Native menubar (File / Edit / View / Help)
│   ├── single-instance.ts          Prevent duplicate app launches
│   ├── data-dir.ts                 Resolve + migrate user data location
│   └── tsconfig.json               Separate tsconfig (CJS, target=node20)
├── build-resources/                NEW — packaging assets
│   ├── icon.icns                   macOS icon
│   ├── icon.ico                    Windows icon
│   ├── icon.png                    Linux icon (512×512)
│   └── entitlements.mac.plist      macOS hardened-runtime entitlements
├── electron-builder.yml            NEW — installer config
├── src/                            Existing Next.js app, unchanged
├── public/                         Existing
├── next.config.js                  MODIFY — add `output: "standalone"`
└── package.json                    MODIFY — Electron deps + scripts + build refs
```

The Electron shell lives **inside** `aic-pipeline/` (one repo, one version, one CI pipeline). Web + desktop ship from the same commit.

---

## 4. Build pipeline

### Dev workflows
- `npm run dev` — Next.js dev server in browser (unchanged from today)
- `npm run electron:dev` — Next.js dev mode inside Electron window (hot reload works)
- `npm run electron:build` — Production build: `next build` + `electron-builder` → installers in `dist/`

### Production build flow
1. `next build` with `output: "standalone"` → produces `.next/standalone/server.js` (portable, no source needed at runtime)
2. `tsc` compiles `electron/*.ts` → `electron/dist/*.js`
3. `electron-builder` packages: compiled electron + standalone Next.js + `node_modules/better-sqlite3` (native) + `src/vendor/fr-config-manager` (since it's `require`d at runtime) + `build-resources/` → outputs:
   - macOS: `pinghub-0.3.0-arm64.dmg`, `pinghub-0.3.0-x64.dmg`
   - Windows: `pinghub-0.3.0-x64-setup.exe`
   - Linux: `pinghub-0.3.0-x64.AppImage`

### CI/CD
GitHub Actions workflow at `.github/workflows/electron-release.yml`. Matrix: `[macos-14 (arm64), macos-13 (x64), windows-latest, ubuntu-latest]`. Triggered on tag push `v*`. Each runner builds its own installer; all artifacts uploaded to the same GitHub Release.

---

## 5. Data directory + migration

**New location:** `app.getPath('userData')` →
- macOS: `~/Library/Application Support/PingHub/`
- Windows: `%APPDATA%\PingHub\`
- Linux: `~/.config/PingHub/`

**What lives there:**
- `pinghub.db` (SQLite)
- `environments/` (per-env .env files + companion JSONs)
- `snapshots/` (existing snapshot layout)
- `logs/` (rotating app log)

**Migration from current dev installs:**
If `process.env.PINGHUB_DATA_DIR` is set (existing convention from `cli.mjs`), honor it.
Otherwise, on first launch, check legacy locations:
- `~/.pinghub/` (likely current dev convention)
- `<cwd>/environments/` (where the dev server writes today)

If legacy data is found, prompt user: "Migrate existing PingHub data to the application data directory? [Migrate] [Use legacy location] [Cancel]". Migration is a one-shot file copy + cutover.

The Next.js app already reads `ENVIRONMENTS_DIR` from a config module — that module needs a small change to honor an env var the Electron main sets at launch:
```ts
process.env.PINGHUB_DATA_DIR = resolveDataDir();   // in electron/main.ts before requiring Next
```

---

## 6. First-run experience

On first launch (no `pinghub.db` exists):
1. Splash window appears immediately while Next.js spins up (~1-3 seconds)
2. Window navigates to the existing app's first-run / empty-state UI
3. (Optional future: a native onboarding wizard before Next.js loads — out of scope for MVP)

Subsequent launches: splash + direct to main UI. Splash dismisses when the Next.js `/` route responds 200.

---

## 7. Security and signing (deferred to v1.1)

**MVP ships unsigned.** Users get OS warnings on first launch:
- macOS: right-click → Open (one-time per app)
- Windows: SmartScreen "More info" → "Run anyway"
- Linux: no warning

**Signing path (v1.1):**
- macOS: Apple Developer ID Application certificate ($99/year membership), notarization via `notarytool`, ship via `@electron/notarize`
- Windows: Authenticode certificate (~$200-500/year), sign via `electron-builder`'s built-in signing
- Linux: not required

Sign-related changes are isolated to `electron-builder.yml` + CI secrets. Code changes minimal.

---

## 8. Auto-update (deferred to v1.1)

`electron-updater` with `provider: github`. App polls Releases on launch; downloads in background; prompts user on quit to apply.

Requires:
- Code signing to be in place first (updates from unsigned source warn the user)
- A `latest-mac.yml` / `latest-win.yml` / `latest-linux.yml` published alongside installers (electron-builder generates these automatically)

---

## 9. Out of scope (v1.0)

- Code signing (defer to v1.1)
- Auto-update (defer to v1.1; depends on signing)
- Tray icon
- Native onboarding wizard (use existing in-app UI)
- Deep links (`pinghub://`)
- Custom installer chrome (DMG layout, NSIS theme)
- Crash reporter integration

---

## 10. Acceptance criteria

- `npm run electron:dev` opens the Next.js app inside an Electron window; hot reload works for renderer code
- `npm run electron:build` on macOS produces working `.dmg` files for both arm64 and intel
- The same command on Windows runner produces a working `.exe`
- The same on Linux produces a working `.AppImage`
- All installers, when run on a fresh OS, launch a window that shows the existing PingHub UI
- `npm test` continues to pass (existing 531 tests)
- `git tag v0.3.0 && git push --tags` triggers a CI workflow that uploads four installer artifacts to a draft GitHub Release
- First-launch on a system with legacy data prompts for migration and migrates successfully
- Existing web dev workflow (`npm run dev`) continues to work unchanged

---

## 11. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `better-sqlite3` ABI mismatch between Electron's Node and the prebuilt binary | High | Run `@electron/rebuild` in postinstall + after `npm ci` in CI |
| Next.js standalone output doesn't include vendored `fr-config-manager` files (it traces only imports) | Medium | Add explicit `outputFileTracingIncludes` config OR copy `src/vendor/` into the package via electron-builder `extraResources` |
| Random port allocation races on first launch | Low | `get-port` is well-tested; fallback to a fixed port if allocation fails |
| Recharts dynamic imports break in standalone bundle | Medium | Test early; if broken, use `transpilePackages: ["recharts"]` in next.config.js |
| macOS Gatekeeper blocks unsigned `.dmg` so completely that users can't even right-click-Open | Low | Test first on a fresh Mac VM; document the bypass in README |
| Multiple instances writing to same SQLite at once | Medium | Single-instance lock via `app.requestSingleInstanceLock()`; second launch focuses existing window |

---

## Self-review

1. **Placeholder scan:** No TBDs. Every section either resolved or explicitly deferred to v1.1 with rationale. ✓
2. **Internal consistency:** Data dir (§5) aligns with first-run migration (§6); CI in §4 aligns with acceptance criteria in §10. ✓
3. **Scope:** Single feature — wrap existing app. Appropriately sized for one plan. ✓
4. **Ambiguity:** Resolved data dir location, port allocation, in-process vs subprocess Next.js, repo location. ✓

Spec ready.
