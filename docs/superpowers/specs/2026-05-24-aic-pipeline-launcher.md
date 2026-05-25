# AIC Pipeline — Launch Script Distribution (Design Spec)

**Date:** 2026-05-24
**Scope:** Distribute the Next.js `aic-pipeline` app as a self-contained portable tarball with a bundled Node binary. Users install via `curl ... | bash` and launch via the `pinghub` command. No browser bundled — the system browser is used.
**Outcome target:** `git tag v0.3.0` → GitHub Actions builds 4 platform tarballs → user runs `curl ... | bash` → has a working `pinghub` command in their PATH within ~30 seconds.

---

## 1. Motivation

After exploring an Electron desktop app and finding click-handler issues in dev mode plus complexity around code signing, asar packaging, and native module ABI matching, we're pivoting to a simpler distribution model: ship the existing Next.js app as a self-contained tarball with a bundled Node runtime, plus a thin launcher script that picks a free port, starts the Next.js server, and opens the system browser.

Trade-offs accepted:
- Users see PingHub in a regular browser tab (not a standalone window). Acceptable — they're devops users comfortable with browser tabs.
- ~150 MB download per platform (Node ~50 MB + Next standalone ~50 MB + node_modules ~50 MB). Comparable to Electron.
- No native window chrome — just a browser tab.

Benefits over Electron:
- No Chromium runtime to maintain (Electron version pin, ABI issues)
- No code signing required (browser handles HTTPS / mixed content concerns are localhost-only)
- All existing Next.js features work exactly as in dev (no asar shenanigans)
- Smaller surface area: one launcher script + one tarball + one install script per OS

---

## 2. User experience

### 2.1 First install (one-time)

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/bostonidentity/PingHub/main/install.sh | bash
```

Output:
```
PingHub installer
✓ Detected: darwin-arm64
✓ Latest version: v0.3.0
✓ Downloading pinghub-darwin-arm64-v0.3.0.tar.gz (148 MB)... done
✓ Extracted to ~/.pinghub/
✓ Symlinked /usr/local/bin/pinghub
✓ Done. Run `pinghub` to start.
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/bostonidentity/PingHub/main/install.ps1 | iex
```

Same flow. Installs into `%LOCALAPPDATA%\PingHub\`, adds to user PATH via registry.

### 2.2 Pinning a version

```bash
PINGHUB_VERSION=v0.3.0 curl -fsSL https://.../install.sh | bash
```

### 2.3 Daily launch

```bash
$ pinghub
[pinghub] using port 47391
[pinghub] starting server...
[pinghub] ready at http://127.0.0.1:47391
[pinghub] opening browser
```

Then Ctrl-C stops the server.

Flags:
- `pinghub --no-open` — start server without auto-opening browser (useful over SSH)
- `pinghub --port 12345` — override the port
- `pinghub --data-dir /path/to/data` — override `PINGHUB_DATA_DIR`
- `pinghub --update` — re-runs the installer to fetch the latest version
- `pinghub --uninstall` — removes `~/.pinghub/` and the PATH symlink
- `pinghub --version` — prints version

### 2.4 Updating

```bash
pinghub --update
```

Effectively re-runs `curl ... | bash`. Idempotent.

---

## 3. Architecture

### 3.1 Install layout (after `install.sh`)

**macOS / Linux:** `~/.pinghub/`
**Windows:** `%LOCALAPPDATA%\PingHub\`

```
~/.pinghub/
├── node                       # bundled Node 20+ binary (or node.exe on Windows)
├── app/
│   ├── package.json           # subset — only what `next start` needs at runtime
│   ├── .next/                 # pre-built standalone server
│   │   └── standalone/
│   │       └── server.js
│   ├── public/                # static assets
│   ├── cli.mjs                # existing thin Next wrapper (untouched)
│   ├── launcher.mjs           # NEW — pick port, spawn, open browser
│   └── src/                   # source needed at runtime (vendor/, etc.)
├── data/                      # default PINGHUB_DATA_DIR
├── version.json               # { "version": "v0.3.0", "installedAt": "..." }
└── pinghub                    # shell shim:  exec "$(dirname $0)/node" "$(dirname $0)/app/launcher.mjs" "$@"
                               # (or pinghub.cmd on Windows)
```

PATH symlink: `/usr/local/bin/pinghub → ~/.pinghub/pinghub`
(Windows: `%LOCALAPPDATA%\PingHub\` added to user PATH via setx)

### 3.2 launcher.mjs flow

```
parse argv (--port, --data-dir, --no-open, --update, --uninstall, --version)

if --update:   re-exec install.sh from network; exit
if --uninstall:rm -rf ~/.pinghub + remove symlink; exit
if --version:  print version.json content; exit

port = argv.port || getPort({ port: 47391 })  // preferred, fall back to free
dataDir = argv["data-dir"] || ~/.pinghub/data
process.env.PINGHUB_DATA_DIR = dataDir

spawn ./node app/.next/standalone/server.js
  with env: { HOSTNAME=127.0.0.1, PORT=port, PINGHUB_DATA_DIR=dataDir }

wait for HTTP /  to respond (poll up to 30s)

if !--no-open:
  mac:     open http://127.0.0.1:${port}
  linux:   xdg-open http://127.0.0.1:${port}
  windows: start http://127.0.0.1:${port}

stream child's stdout/stderr to our stdout/stderr
on SIGINT/SIGTERM: SIGTERM child, wait 3s, exit
```

### 3.3 Tarball contents

```
pinghub-<platform>-<arch>-<version>.tar.gz
├── node                       (~50 MB on mac arm64, similar elsewhere)
├── app/
│   ├── .next/standalone/      (the Next build)
│   ├── .next/static/          (CSS, chunks)
│   ├── public/
│   ├── package.json
│   ├── cli.mjs
│   ├── launcher.mjs
│   ├── src/vendor/            (vendored fr-config-manager etc.)
│   └── node_modules/          (only runtime deps after pruning)
├── pinghub                    (shell shim, executable)
└── version.json
```

Windows variant is a `.zip` instead of `.tar.gz` and uses `pinghub.cmd` + `node.exe`.

### 3.4 Repo layout

```
aic-pipeline/
├── launcher/                       NEW
│   ├── launcher.mjs                The main launcher (lives here in source; copied to app/ in tarball)
│   ├── install.sh                  Bash installer (mac + linux)
│   ├── install.ps1                 PowerShell installer (Windows)
│   ├── build-tarball.mjs           Builds one platform's tarball
│   └── README.md                   Devs-facing notes for the launcher subsystem
├── .github/workflows/
│   └── launcher-release.yml        NEW — tag-triggered builds
├── cli.mjs                         Existing — unchanged
├── package.json                    MODIFY — add scripts
└── ...rest unchanged
```

---

## 4. Versions and platform matrix

**Node version:** 20 LTS (latest 20.x at build time). Match what the app's `engines.node` requires (currently unspecified — add `"engines": { "node": ">=20" }` to package.json).

**Platform matrix:**

| OS | Arch | Node binary source | Archive |
|---|---|---|---|
| macOS | arm64 | nodejs.org/dist/v20.x/node-v20.x-darwin-arm64.tar.gz | .tar.gz |
| macOS | x64 | nodejs.org/dist/v20.x/node-v20.x-darwin-x64.tar.gz | .tar.gz |
| Linux | x64 | nodejs.org/dist/v20.x/node-v20.x-linux-x64.tar.gz | .tar.gz |
| Windows | x64 | nodejs.org/dist/v20.x/node-v20.x-win-x64.zip | .zip |

---

## 5. Installer script contracts

### 5.1 install.sh (bash)

Behavior:
1. Detect platform: `uname -s` (Darwin / Linux), `uname -m` (arm64 / x86_64)
2. Map to release asset name: e.g., `pinghub-darwin-arm64-<version>.tar.gz`
3. Determine version:
   - If `$PINGHUB_VERSION` set: use it
   - Else: GET `https://api.github.com/repos/bostonidentity/PingHub/releases/latest`, parse `tag_name`
4. Download asset: `curl -fLO https://github.com/.../releases/download/<version>/<asset>`
5. Extract to `~/.pinghub/` (overwriting any prior install except `data/`)
6. Make `~/.pinghub/pinghub` executable
7. Symlink: `ln -sf ~/.pinghub/pinghub /usr/local/bin/pinghub`
   - Fall back to `~/.local/bin/pinghub` if no write access to /usr/local/bin
   - Print which one was used + reminder to ensure it's in PATH
8. Write `~/.pinghub/version.json`
9. Print: `Done. Run 'pinghub' to start.`

Error modes:
- Unsupported platform → exit 1 with clear message
- Network failure → exit 2 with `curl` error
- Insufficient permissions → exit 3 with sudo hint

### 5.2 install.ps1 (PowerShell)

Same logic, Windows-flavored:
- Platform always `win-x64` (skip arm64 for v0.3.0)
- Install to `$env:LOCALAPPDATA\PingHub\`
- Add to user PATH via `[Environment]::SetEnvironmentVariable("PATH", ..., "User")`
- No symlink — the install dir is added to PATH directly

---

## 6. Build pipeline

### 6.1 Local: `npm run launcher:build:darwin-arm64`

`launcher/build-tarball.mjs` accepts `--platform <os>` `--arch <arch>` and:
1. Verifies `npm run build` has been run (or runs it)
2. Downloads the matching Node binary (cached locally in `.tarball-cache/`)
3. Creates a staging dir
4. Copies: node binary, `.next/standalone/`, `.next/static/`, `public/`, `src/vendor/`, `cli.mjs`, `launcher.mjs`, pruned `package.json`
5. Writes `version.json`
6. Creates `pinghub` shim (or `pinghub.cmd` on Windows)
7. Tar/zip the staging dir → `dist/pinghub-<platform>-<arch>-<version>.tar.gz`

### 6.2 CI: GitHub Actions

`.github/workflows/launcher-release.yml` triggers on `v*` tags. Matrix of 4 runners (mac arm64, mac x64, linux x64, windows x64), each running `npm run launcher:build:<platform>-<arch>` and uploading the artifact.

After all 4 builds: a `release` job downloads artifacts and creates a draft GitHub Release with all 4 attached.

---

## 7. Update + uninstall

### 7.1 `pinghub --update`

```
1. Read ~/.pinghub/version.json → current version
2. Query GitHub API for latest tag
3. If equal: print "already at latest (v0.3.0)", exit 0
4. If different: re-exec install.sh from network with PINGHUB_VERSION=<latest>
```

### 7.2 `pinghub --uninstall`

```
1. Confirm with user
2. Remove PATH symlink (/usr/local/bin/pinghub or ~/.local/bin/pinghub)
3. rm -rf ~/.pinghub/   (BUT preserve ~/.pinghub/data/ unless --purge passed)
4. Print: "Uninstalled. Data preserved at ~/.pinghub-data/" (renamed before deletion)
```

Note: deliberately preserve user data on uninstall (rename to `~/.pinghub-data/` before purge) to avoid catastrophic data loss.

---

## 8. Acceptance criteria

- `npm run launcher:build:darwin-arm64` on macOS produces a working tarball; extracting + running `pinghub` opens the app
- `bash install.sh` on a clean macOS user (no `~/.pinghub` existing) installs + symlinks + prints clear success
- `pinghub` from a fresh terminal launches the server + opens browser
- `pinghub --port 12345 --no-open` honors flags
- `pinghub --update` re-runs the install and prints "already at latest" when already current
- `pinghub --uninstall` removes install, preserves data
- GitHub Actions builds all 4 tarballs on tag push (manual verification via tag like `v0.3.0-rc.1`)
- README documents the install command + flag reference

---

## 9. Out of scope (v0.3.0)

- macOS / Windows code signing (not relevant — bash scripts and tarballs don't need signing)
- Apple notarization
- Auto-update on launch (manual `--update` only)
- arm64 Linux / Windows
- systemd / launchd auto-start
- Per-user vs system-wide install (always per-user)
- Telemetry / crash reporting

---

## 10. Risks + mitigations

| Risk | Mitigation |
|---|---|
| `better-sqlite3` native binary doesn't match bundled Node ABI | Build the tarball ON the target platform (matrix CI). Don't cross-compile. Node version is pinned. |
| /usr/local/bin not writable on some macOS setups | Fall back to ~/.local/bin with clear PATH instructions |
| Windows ExecutionPolicy blocks install.ps1 | install.ps1 uses `-ExecutionPolicy Bypass` invocation; document if blocked |
| GitHub raw URL changes (e.g., default branch rename) | Pin in docs; can swap to custom domain later |
| Tarball size (~150 MB) feels heavy | Document; comparable to Electron. Offer per-platform downloads so users only pull what they need. |
| User's existing Node version is incompatible with the bundled Node ABI of better-sqlite3 | N/A — we use bundled Node, not system Node |
| Stale version after months of no use | `--update` is simple; CI can also build a "rolling" release. v0.3.0 punt. |

---

## Self-review

1. **Placeholders:** None. Each section has a concrete approach. ✓
2. **Consistency:** Install paths consistent across §3.1, §5, §7. Flag set consistent across §2.3, §3.2. ✓
3. **Scope:** Single coherent feature. Could be one plan. ✓
4. **Ambiguity:** Resolved per-platform behavior, PATH locations, version pinning. ✓

Spec ready.
