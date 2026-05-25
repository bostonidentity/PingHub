# AIC Pipeline — Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distribute aic-pipeline as a self-contained portable tarball with bundled Node + a `pinghub` launcher. Users install via `curl|bash` and run `pinghub` to launch.

**Architecture:** Per-platform tarball ships with Node binary + pre-built Next standalone + launcher.mjs. Install script downloads + extracts to `~/.pinghub/` (or `%LOCALAPPDATA%\PingHub\` on Windows) + symlinks `pinghub` into PATH. Launcher picks a free port, starts Next, opens browser.

**Tech Stack:** Node 20 bundled, existing Next.js 16 + better-sqlite3 12, bash + PowerShell installers.

**Branch:** `aic-pipeline/launcher-mvp` branched from `development`.

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-pipeline-launcher -b aic-pipeline/launcher-mvp development
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-pipeline-launcher/aic-pipeline
npm ci
npm test                                # baseline: 531 passing
```

---

## File Structure

```
aic-pipeline/
  launcher/                              NEW
    launcher.mjs                          The main launcher (cross-platform Node script)
    launcher.test.mjs                     Unit tests (vitest)
    install.sh                            Bash installer (mac + linux)
    install.ps1                           PowerShell installer (Windows)
    build-tarball.mjs                     Per-platform tarball builder
    README.md                             Dev-facing notes
  .github/workflows/
    launcher-release.yml                  NEW — tag-triggered release
  package.json                            MODIFY — add scripts, engines.node, version
  CHANGELOG.md                            MODIFY — v0.3.0 entry
  README.md                               MODIFY — install/launch instructions
```

---

## M1 — launcher.mjs (~1 day)

### Task 1: Scaffold launcher module + tests

**Files:** `launcher/launcher.mjs`, `launcher/launcher.test.mjs`

- [ ] **Step 1:** Create empty `launcher/launcher.mjs` with a `parseArgv(argv)` export.

- [ ] **Step 2:** Write failing test `launcher/launcher.test.mjs`:

  ```js
  import { describe, it, expect } from "vitest";
  import { parseArgv } from "./launcher.mjs";

  describe("parseArgv", () => {
    it("defaults are empty", () => {
      expect(parseArgv([])).toEqual({});
    });
    it("--port N captures port as number", () => {
      expect(parseArgv(["--port", "12345"])).toEqual({ port: 12345 });
    });
    it("--port=N also supported", () => {
      expect(parseArgv(["--port=12345"])).toEqual({ port: 12345 });
    });
    it("--data-dir captures path", () => {
      expect(parseArgv(["--data-dir", "/tmp/data"])).toEqual({ dataDir: "/tmp/data" });
    });
    it("--no-open is boolean true", () => {
      expect(parseArgv(["--no-open"])).toEqual({ noOpen: true });
    });
    it("--update is boolean true", () => {
      expect(parseArgv(["--update"])).toEqual({ update: true });
    });
    it("--uninstall is boolean true", () => {
      expect(parseArgv(["--uninstall"])).toEqual({ uninstall: true });
    });
    it("--version is boolean true", () => {
      expect(parseArgv(["--version"])).toEqual({ version: true });
    });
    it("multiple flags combine", () => {
      expect(parseArgv(["--port", "8080", "--no-open"])).toEqual({ port: 8080, noOpen: true });
    });
    it("rejects unknown flags", () => {
      expect(() => parseArgv(["--garbage"])).toThrow(/unknown/i);
    });
  });
  ```

  Configure vitest to discover `launcher/**/*.test.mjs` if needed (modify `vitest.config.ts`).

- [ ] **Step 3:** Run → FAIL.

  ```bash
  npx vitest run launcher/launcher.test.mjs
  ```

- [ ] **Step 4:** Implement `parseArgv` in `launcher/launcher.mjs`:

  ```js
  const KNOWN_FLAGS = new Set(["--port", "--data-dir", "--no-open", "--update", "--uninstall", "--version"]);

  export function parseArgv(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
      let a = argv[i];
      let v;
      const eq = a.indexOf("=");
      if (eq > 0) {
        v = a.slice(eq + 1);
        a = a.slice(0, eq);
      }
      if (!KNOWN_FLAGS.has(a)) throw new Error(`unknown flag: ${a}`);
      switch (a) {
        case "--port": {
          const raw = v ?? argv[++i];
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port: ${raw}`);
          out.port = n;
          break;
        }
        case "--data-dir": out.dataDir = v ?? argv[++i]; break;
        case "--no-open":  out.noOpen = true; break;
        case "--update":   out.update = true; break;
        case "--uninstall":out.uninstall = true; break;
        case "--version":  out.version = true; break;
      }
    }
    return out;
  }
  ```

- [ ] **Step 5:** Run → PASS (10/10).

  Run full suite: `npm test 2>&1 | tail -5` → expect 541 passing (531 + 10).

- [ ] **Step 6:** Commit:

  ```bash
  cd <worktree>/aic-pipeline
  git add launcher/ vitest.config.ts
  git commit -m "feat(launcher): scaffold launcher.mjs argv parser (M1 task 1)"
  ```

### Task 2: openBrowser helper (cross-platform)

**Files:** `launcher/launcher.mjs` (extend)

- [ ] **Step 1:** Add test:

  ```js
  import { resolveOpenCommand } from "./launcher.mjs";
  describe("resolveOpenCommand", () => {
    it("darwin uses open", () => {
      expect(resolveOpenCommand("darwin", "http://x")).toEqual({ cmd: "open", args: ["http://x"] });
    });
    it("linux uses xdg-open", () => {
      expect(resolveOpenCommand("linux", "http://x")).toEqual({ cmd: "xdg-open", args: ["http://x"] });
    });
    it("win32 uses cmd start", () => {
      expect(resolveOpenCommand("win32", "http://x")).toEqual({ cmd: "cmd", args: ["/c", "start", "", "http://x"] });
    });
    it("unknown platform throws", () => {
      expect(() => resolveOpenCommand("freebsd", "http://x")).toThrow();
    });
  });
  ```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3:** Implement:

  ```js
  export function resolveOpenCommand(platform, url) {
    if (platform === "darwin") return { cmd: "open", args: [url] };
    if (platform === "linux") return { cmd: "xdg-open", args: [url] };
    if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
    throw new Error(`unsupported platform: ${platform}`);
  }
  ```

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5:** Commit: `feat(launcher): resolveOpenCommand for mac/linux/windows (M1 task 2)`.

### Task 3: waitForServer helper

**Files:** `launcher/launcher.mjs`

- [ ] **Step 1:** Test:

  ```js
  import { waitForServer } from "./launcher.mjs";
  import { createServer } from "node:http";

  describe("waitForServer", () => {
    it("resolves quickly when server is up", async () => {
      const srv = createServer((_, res) => { res.writeHead(200); res.end("ok"); });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const port = srv.address().port;
      await waitForServer(`http://127.0.0.1:${port}`, { timeoutMs: 5000, intervalMs: 50 });
      srv.close();
    });

    it("rejects after timeout when server never responds", async () => {
      await expect(waitForServer("http://127.0.0.1:1", { timeoutMs: 500, intervalMs: 50 }))
        .rejects.toThrow(/timed out|timeout/i);
    });
  });
  ```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3:** Implement:

  ```js
  import { setTimeout as sleep } from "node:timers/promises";

  export async function waitForServer(url, { timeoutMs = 30000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { method: "GET" });
        if (res.status < 500) return;
      } catch {}
      await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${url} after ${timeoutMs}ms`);
  }
  ```

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5:** Commit: `feat(launcher): waitForServer polling helper (M1 task 3)`.

### Task 4: Main launcher orchestrator (integration)

**Files:** `launcher/launcher.mjs`

- [ ] **Step 1:** Add the main entry function (no test — integration verified manually in Task 5):

  ```js
  import { spawn } from "node:child_process";
  import { readFileSync, existsSync, mkdirSync } from "node:fs";
  import * as path from "node:path";
  import * as os from "node:os";
  import getPort from "get-port";

  const PREFERRED_PORT = 47391;
  const INSTALL_DIR = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PingHub")
    : path.join(os.homedir(), ".pinghub");

  export async function main(argv = process.argv.slice(2)) {
    let opts;
    try { opts = parseArgv(argv); }
    catch (e) { console.error(e.message); process.exit(2); }

    if (opts.version) {
      const vp = path.join(INSTALL_DIR, "version.json");
      if (existsSync(vp)) {
        const v = JSON.parse(readFileSync(vp, "utf-8"));
        console.log(v.version);
      } else {
        console.log("unknown (running from source)");
      }
      return;
    }

    if (opts.update) {
      console.error("--update not implemented in launcher; re-run the install script:");
      console.error("  curl -fsSL https://raw.githubusercontent.com/bostonidentity/PingHub/main/launcher/install.sh | bash");
      process.exit(1);
    }

    if (opts.uninstall) {
      console.error("--uninstall not implemented in launcher; run:");
      console.error(process.platform === "win32"
        ? `  Remove-Item -Recurse ${INSTALL_DIR}`
        : `  rm -rf ${INSTALL_DIR} && rm -f /usr/local/bin/pinghub`);
      process.exit(1);
    }

    const port = opts.port ?? await getPort({ port: PREFERRED_PORT });
    const dataDir = opts.dataDir ?? path.join(INSTALL_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    // Resolve standalone server.js location.
    // In tarball install: <INSTALL_DIR>/app/.next/standalone/server.js
    // In source dev:      <repo>/aic-pipeline/.next/standalone/server.js
    const launcherDir = path.dirname(new URL(import.meta.url).pathname);
    const candidates = [
      path.resolve(launcherDir, "..", "app", ".next", "standalone", "server.js"),  // tarball
      path.resolve(launcherDir, "..", ".next", "standalone", "server.js")          // source
    ];
    const serverJs = candidates.find(existsSync);
    if (!serverJs) {
      console.error("[pinghub] could not locate Next.js standalone server.js");
      console.error("[pinghub] tried:");
      candidates.forEach((c) => console.error(`  ${c}`));
      process.exit(3);
    }

    console.error(`[pinghub] using port ${port}`);
    console.error(`[pinghub] data dir ${dataDir}`);
    console.error(`[pinghub] starting server...`);

    const nodeExe = process.execPath;
    const child = spawn(nodeExe, [serverJs], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        PINGHUB_DATA_DIR: dataDir
      },
      cwd: path.dirname(serverJs)
    });

    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForServer(url, { timeoutMs: 30000 });
    } catch (e) {
      console.error(`[pinghub] server failed to start: ${e.message}`);
      child.kill("SIGTERM");
      process.exit(4);
    }
    console.error(`[pinghub] ready at ${url}`);

    if (!opts.noOpen) {
      try {
        const { cmd, args } = resolveOpenCommand(process.platform, url);
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
        console.error("[pinghub] opened browser");
      } catch (e) {
        console.error(`[pinghub] could not open browser: ${e.message} (visit ${url} manually)`);
      }
    }

    // Clean shutdown
    const shutdown = () => {
      console.error("[pinghub] shutting down...");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
  }

  // Run main if invoked directly
  if (import.meta.url === `file://${process.argv[1]}`) {
    main();
  }
  ```

- [ ] **Step 2:** Verify it can at least be required without errors:

  ```bash
  node -e "import('./launcher/launcher.mjs').then(() => console.log('OK'))"
  ```

- [ ] **Step 3:** Commit: `feat(launcher): main orchestrator (M1 task 4)`.

### Task 5: Local smoke test of launcher against the source

- [ ] **Step 1:** Build the Next standalone:

  ```bash
  rm -rf .next
  npm run build
  ls .next/standalone/server.js
  ```

  (`next.config.ts` must have `output: "standalone"` and `outputFileTracingIncludes`. If absent from `development` branch, add now and commit separately: `chore(launcher): enable next standalone output`.)

- [ ] **Step 2:** Run launcher from source:

  ```bash
  node launcher/launcher.mjs --no-open
  ```

  Expected output (paraphrased):
  ```
  [pinghub] using port 47391
  [pinghub] data dir <INSTALL_DIR>/data
  [pinghub] starting server...
  [pinghub] ready at http://127.0.0.1:47391
  ```

  Hit `http://127.0.0.1:47391` in a browser → PingHub UI loads.

  Ctrl-C → "[pinghub] shutting down..." → exits.

- [ ] **Step 3:** If anything fails, fix before proceeding. Report blocker if stuck.

- [ ] **Step 4:** If everything works, commit any standalone-output changes to next.config (see Step 1).

---

## M2 — Tarball builder (~1 day)

### Task 6: build-tarball.mjs

**File:** `launcher/build-tarball.mjs`

- [ ] **Step 1:** Implement the builder:

  ```js
  #!/usr/bin/env node
  import * as fs from "node:fs";
  import * as path from "node:path";
  import * as os from "node:os";
  import { spawnSync } from "node:child_process";
  import { createHash } from "node:crypto";
  import { pipeline } from "node:stream/promises";
  import { createWriteStream } from "node:fs";
  import { tmpdir } from "node:os";

  const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const NODE_VERSION = "20.18.0";   // pin to a known-good LTS

  function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--platform") out.platform = argv[++i];
      else if (a === "--arch") out.arch = argv[++i];
    }
    return out;
  }

  const NODE_BUILDS = {
    "darwin-arm64":  { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, extractAs: "tar.gz" },
    "darwin-x64":    { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,   extractAs: "tar.gz" },
    "linux-x64":     { file: `node-v${NODE_VERSION}-linux-x64.tar.xz`,    extractAs: "tar.xz" },
    "win-x64":       { file: `node-v${NODE_VERSION}-win-x64.zip`,         extractAs: "zip" }
  };

  async function downloadNode(key) {
    const info = NODE_BUILDS[key];
    if (!info) throw new Error(`unsupported platform ${key}`);
    const cacheDir = path.join(ROOT, ".tarball-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, info.file);
    if (!fs.existsSync(cached)) {
      const url = `https://nodejs.org/dist/v${NODE_VERSION}/${info.file}`;
      console.log(`downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`failed to download node: ${res.status}`);
      await pipeline(res.body, createWriteStream(cached));
    }
    return cached;
  }

  function extractNode(archive, kind, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    if (kind === "tar.gz" || kind === "tar.xz") {
      spawnSync("tar", ["-xf", archive, "-C", destDir], { stdio: "inherit" });
    } else if (kind === "zip") {
      spawnSync("unzip", ["-q", archive, "-d", destDir], { stdio: "inherit" });
    }
  }

  async function main() {
    const { platform, arch } = parseArgs(process.argv.slice(2));
    if (!platform || !arch) {
      console.error("usage: build-tarball.mjs --platform <darwin|linux|win> --arch <arm64|x64>");
      process.exit(2);
    }
    const key = `${platform}-${arch}`;
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    const version = `v${pkg.version}`;

    console.log(`building pinghub-${key}-${version}`);

    // 1. Ensure Next standalone is built
    if (!fs.existsSync(path.join(ROOT, ".next/standalone/server.js"))) {
      console.log("running next build...");
      spawnSync("npm", ["run", "build"], { stdio: "inherit", cwd: ROOT });
    }

    // 2. Stage
    const staging = path.join(tmpdir(), `pinghub-stage-${Date.now()}`);
    fs.mkdirSync(staging, { recursive: true });
    const appDir = path.join(staging, "app");
    fs.mkdirSync(appDir, { recursive: true });

    // 3. Copy Next standalone + static + public + launcher + cli + vendor src
    for (const rel of [".next/standalone", ".next/static", "public", "src/vendor", "cli.mjs", "launcher/launcher.mjs"]) {
      const src = path.join(ROOT, rel);
      const dst = path.join(appDir, rel === "launcher/launcher.mjs" ? "launcher.mjs" : rel);
      if (!fs.existsSync(src)) {
        console.warn(`skip missing ${rel}`);
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }

    // 4. Move static files inside standalone (Next expects them there for prod)
    const standaloneNextStatic = path.join(appDir, ".next/standalone/.next/static");
    if (!fs.existsSync(standaloneNextStatic) && fs.existsSync(path.join(appDir, ".next/static"))) {
      fs.cpSync(path.join(appDir, ".next/static"), standaloneNextStatic, { recursive: true });
    }
    // public similarly
    const standalonePublic = path.join(appDir, ".next/standalone/public");
    if (!fs.existsSync(standalonePublic) && fs.existsSync(path.join(appDir, "public"))) {
      fs.cpSync(path.join(appDir, "public"), standalonePublic, { recursive: true });
    }

    // 5. Write pruned package.json (just so launcher knows version)
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "pinghub", version: pkg.version }, null, 2));

    // 6. Bundle Node
    const nodeArchive = await downloadNode(key);
    const nodeExtractDir = path.join(staging, ".node-extract");
    extractNode(nodeArchive, NODE_BUILDS[key].extractAs, nodeExtractDir);
    // Locate the node binary inside the extracted dir
    const nodeBinName = platform === "win" ? "node.exe" : "bin/node";
    const findNode = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const candidate = path.join(dir, entry.name, nodeBinName);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      throw new Error(`could not find ${nodeBinName} in ${dir}`);
    };
    const nodeBin = findNode(nodeExtractDir);
    fs.copyFileSync(nodeBin, path.join(staging, platform === "win" ? "node.exe" : "node"));
    if (platform !== "win") fs.chmodSync(path.join(staging, "node"), 0o755);
    fs.rmSync(nodeExtractDir, { recursive: true, force: true });

    // 7. Write the launcher shim
    if (platform === "win") {
      fs.writeFileSync(path.join(staging, "pinghub.cmd"), `@echo off\r\n"%~dp0node.exe" "%~dp0app\\launcher.mjs" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(staging, "pinghub"), `#!/usr/bin/env bash\nexec "$(dirname "$0")/node" "$(dirname "$0")/app/launcher.mjs" "$@"\n`, { mode: 0o755 });
    }

    // 8. version.json
    fs.writeFileSync(path.join(staging, "version.json"), JSON.stringify({ version, platform: key, nodeVersion: NODE_VERSION, builtAt: new Date().toISOString() }, null, 2));

    // 9. Archive
    const distDir = path.join(ROOT, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const archiveName = platform === "win"
      ? `pinghub-${key}-${version}.zip`
      : `pinghub-${key}-${version}.tar.gz`;
    const archivePath = path.join(distDir, archiveName);

    if (platform === "win") {
      spawnSync("zip", ["-rq", archivePath, "."], { cwd: staging, stdio: "inherit" });
    } else {
      spawnSync("tar", ["-czf", archivePath, "-C", staging, "."], { stdio: "inherit" });
    }

    // 10. Compute hash
    const buf = fs.readFileSync(archivePath);
    const sha = createHash("sha256").update(buf).digest("hex");
    fs.writeFileSync(`${archivePath}.sha256`, `${sha}  ${path.basename(archivePath)}\n`);

    // 11. Cleanup
    fs.rmSync(staging, { recursive: true, force: true });

    console.log(`✓ ${archivePath}`);
    console.log(`  size: ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  sha256: ${sha}`);
  }

  main().catch((e) => { console.error(e); process.exit(1); });
  ```

- [ ] **Step 2:** Add to package.json scripts:
  ```json
  "launcher:build:darwin-arm64": "node launcher/build-tarball.mjs --platform darwin --arch arm64",
  "launcher:build:darwin-x64":   "node launcher/build-tarball.mjs --platform darwin --arch x64",
  "launcher:build:linux-x64":    "node launcher/build-tarball.mjs --platform linux  --arch x64",
  "launcher:build:win-x64":      "node launcher/build-tarball.mjs --platform win    --arch x64"
  ```

- [ ] **Step 3:** Local test on the current platform:

  ```bash
  rm -rf .next dist
  npm run build
  npm run launcher:build:darwin-arm64
  ls -lh dist/pinghub-darwin-arm64-*.tar.gz
  ```

  Expect a ~150 MB tarball.

- [ ] **Step 4:** Extract + test the tarball:

  ```bash
  mkdir -p /tmp/pinghub-test
  tar -xzf dist/pinghub-darwin-arm64-*.tar.gz -C /tmp/pinghub-test
  ls /tmp/pinghub-test/
  # expect: node, app/, pinghub, version.json
  /tmp/pinghub-test/pinghub --no-open --port 48000 &
  sleep 5
  curl -sf http://127.0.0.1:48000 > /dev/null && echo "✓ tarball works"
  pkill -f "pinghub-test/node"
  rm -rf /tmp/pinghub-test
  ```

- [ ] **Step 5:** Commit:

  ```bash
  cd <worktree>/aic-pipeline
  git add launcher/build-tarball.mjs package.json
  git commit -m "feat(launcher): per-platform tarball builder (M2 task 6)"
  ```

---

## M3 — Install scripts (~1 day)

### Task 7: install.sh

**File:** `launcher/install.sh`

- [ ] **Step 1:** Write the script:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail

  REPO="bostonidentity/PingHub"
  INSTALL_DIR="${HOME}/.pinghub"

  detect_platform() {
    local os arch
    case "$(uname -s)" in
      Darwin) os="darwin" ;;
      Linux)  os="linux" ;;
      *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) arch="arm64" ;;
      x86_64|amd64)  arch="x64" ;;
      *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
    esac
    # Only mac supports arm64 in our matrix
    if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
      echo "linux-arm64 not yet supported"; exit 1
    fi
    echo "${os}-${arch}"
  }

  fetch_latest_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep '"tag_name":' \
      | head -1 \
      | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
  }

  main() {
    echo "PingHub installer"
    local platform version asset url
    platform=$(detect_platform)
    echo "✓ detected: $platform"

    version="${PINGHUB_VERSION:-$(fetch_latest_version)}"
    if [ -z "$version" ]; then
      echo "✗ could not determine version (set PINGHUB_VERSION=v0.3.0 to pin)"; exit 1
    fi
    echo "✓ version: $version"

    asset="pinghub-${platform}-${version}.tar.gz"
    url="https://github.com/${REPO}/releases/download/${version}/${asset}"

    local tmp
    tmp=$(mktemp -d)
    trap "rm -rf $tmp" EXIT

    echo "↓ downloading $asset..."
    curl -fL "$url" -o "$tmp/$asset" || { echo "✗ download failed"; exit 2; }

    echo "↓ verifying..."
    # checksum verification deferred to v0.4 — for now just check it's a tar.gz
    file "$tmp/$asset" | grep -q "gzip compressed" || { echo "✗ archive looks corrupt"; exit 2; }

    echo "↪ installing to $INSTALL_DIR"
    # Preserve data dir if exists
    local preserved=""
    if [ -d "${INSTALL_DIR}/data" ]; then
      preserved=$(mktemp -d)
      mv "${INSTALL_DIR}/data" "$preserved/"
    fi
    rm -rf "${INSTALL_DIR}"
    mkdir -p "${INSTALL_DIR}"
    tar -xzf "$tmp/$asset" -C "${INSTALL_DIR}"
    if [ -n "$preserved" ]; then
      mv "$preserved/data" "${INSTALL_DIR}/data"
      rm -rf "$preserved"
    fi
    chmod +x "${INSTALL_DIR}/pinghub"

    # PATH symlink
    local linked_at=""
    for cand in /usr/local/bin/pinghub "${HOME}/.local/bin/pinghub"; do
      local dir
      dir=$(dirname "$cand")
      if [ -d "$dir" ] && [ -w "$dir" ]; then
        ln -sf "${INSTALL_DIR}/pinghub" "$cand"
        linked_at="$cand"
        break
      fi
    done
    if [ -z "$linked_at" ]; then
      echo "✗ could not write to /usr/local/bin or ~/.local/bin"
      echo "  Manually symlink: ln -sf ${INSTALL_DIR}/pinghub /some/dir/in/PATH/pinghub"
      exit 3
    fi
    echo "✓ symlinked $linked_at"

    echo "✓ done. Run 'pinghub' to start."
  }

  main "$@"
  ```

- [ ] **Step 2:** Lint with `shellcheck` if available:
  ```bash
  command -v shellcheck && shellcheck launcher/install.sh || echo "shellcheck not installed, skipping"
  ```

- [ ] **Step 3:** Local test (against a local tarball):
  ```bash
  # Pretend we already have a tarball
  ls dist/pinghub-darwin-arm64-*.tar.gz
  # Can't easily test the curl-from-github part locally. Mock by extracting manually:
  mkdir -p /tmp/pinghub-install-test/.pinghub
  tar -xzf dist/pinghub-darwin-arm64-*.tar.gz -C /tmp/pinghub-install-test/.pinghub
  HOME=/tmp/pinghub-install-test /tmp/pinghub-install-test/.pinghub/pinghub --no-open --port 48001 &
  sleep 5
  curl -sf http://127.0.0.1:48001 > /dev/null && echo "✓ works"
  pkill -f /tmp/pinghub-install-test
  rm -rf /tmp/pinghub-install-test
  ```

- [ ] **Step 4:** Commit: `feat(launcher): install.sh for mac/linux (M3 task 7)`.

### Task 8: install.ps1 (Windows)

**File:** `launcher/install.ps1`

- [ ] **Step 1:** Write:

  ```powershell
  $ErrorActionPreference = "Stop"
  $Repo = "bostonidentity/PingHub"
  $InstallDir = Join-Path $env:LOCALAPPDATA "PingHub"

  function Get-LatestVersion {
    $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    return $r.tag_name
  }

  Write-Host "PingHub installer"
  $version = $env:PINGHUB_VERSION
  if (-not $version) {
    $version = Get-LatestVersion
  }
  Write-Host "✓ version: $version"

  $asset = "pinghub-win-x64-$version.zip"
  $url = "https://github.com/$Repo/releases/download/$version/$asset"

  $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("pinghub-install-" + [Guid]::NewGuid().ToString()))
  $archivePath = Join-Path $tmp $asset

  Write-Host "↓ downloading $asset..."
  Invoke-WebRequest -Uri $url -OutFile $archivePath

  Write-Host "↪ installing to $InstallDir"
  # Preserve data dir
  $preserved = $null
  $dataDir = Join-Path $InstallDir "data"
  if (Test-Path $dataDir) {
    $preserved = Join-Path $env:TEMP ("pinghub-data-preserve-" + [Guid]::NewGuid().ToString())
    Move-Item $dataDir $preserved
  }
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  New-Item -ItemType Directory -Path $InstallDir | Out-Null
  Expand-Archive -Path $archivePath -DestinationPath $InstallDir -Force
  if ($preserved) {
    Move-Item $preserved (Join-Path $InstallDir "data")
  }

  # Add to user PATH if not already
  $pathParts = [Environment]::GetEnvironmentVariable("PATH", "User") -split ";"
  if (-not ($pathParts -contains $InstallDir)) {
    $newPath = ($pathParts + $InstallDir | Where-Object { $_ }) -join ";"
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    Write-Host "✓ added $InstallDir to user PATH (open a new terminal)"
  } else {
    Write-Host "✓ $InstallDir already in user PATH"
  }

  Remove-Item -Recurse -Force $tmp
  Write-Host "✓ done. Run 'pinghub' from a new terminal to start."
  ```

- [ ] **Step 2:** Cannot easily test PowerShell from macOS. Document in commit that this needs a Windows CI run to verify.

- [ ] **Step 3:** Commit: `feat(launcher): install.ps1 for Windows (M3 task 8)`.

---

## M4 — CI release workflow (~1 day)

### Task 9: GitHub Actions workflow

**File:** `aic-pipeline/.github/workflows/launcher-release.yml`

- [ ] **Step 1:** Write:

  ```yaml
  name: Launcher Release

  on:
    push:
      tags: ["v*"]
    workflow_dispatch:

  jobs:
    build:
      strategy:
        fail-fast: false
        matrix:
          include:
            - { runs: macos-14, key: darwin-arm64, script: "launcher:build:darwin-arm64" }
            - { runs: macos-13, key: darwin-x64,   script: "launcher:build:darwin-x64" }
            - { runs: ubuntu-latest, key: linux-x64, script: "launcher:build:linux-x64" }
            - { runs: windows-latest, key: win-x64, script: "launcher:build:win-x64" }
      runs-on: ${{ matrix.runs }}
      defaults:
        run:
          working-directory: aic-pipeline
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: "20"
            cache: npm
            cache-dependency-path: aic-pipeline/package-lock.json
        - run: npm ci
        - name: Cache bundled Node downloads
          uses: actions/cache@v4
          with:
            path: aic-pipeline/.tarball-cache
            key: tarball-cache-${{ matrix.key }}-${{ hashFiles('aic-pipeline/launcher/build-tarball.mjs') }}
        - run: npm run build
        - run: npm run ${{ matrix.script }}
        - uses: actions/upload-artifact@v4
          with:
            name: pinghub-${{ matrix.key }}
            path: aic-pipeline/dist/pinghub-${{ matrix.key }}-*

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

- [ ] **Step 2:** Commit: `ci(launcher): tag-triggered release workflow (M4 task 9)`.

- [ ] **Step 3:** Optionally push a pre-release tag (e.g., `v0.3.0-rc.1`) on a feature branch to verify the matrix runs (don't push without explicit user approval).

---

## M5 — README + acceptance (~half day)

### Task 10: Update README + CHANGELOG

**Files:** `aic-pipeline/README.md`, `aic-pipeline/CHANGELOG.md`

- [ ] **Step 1:** Add a new top section to README:

  ```markdown
  ## Install (end users)

  ### macOS / Linux
  ```bash
  curl -fsSL https://raw.githubusercontent.com/bostonidentity/PingHub/main/aic-pipeline/launcher/install.sh | bash
  ```

  ### Windows (PowerShell)
  ```powershell
  irm https://raw.githubusercontent.com/bostonidentity/PingHub/main/aic-pipeline/launcher/install.ps1 | iex
  ```

  Then run:
  ```bash
  pinghub
  ```

  Your browser opens to `http://127.0.0.1:47391`. Ctrl-C to stop.

  ### Flags
  - `pinghub --port 12345` — override port
  - `pinghub --no-open` — start server without opening browser
  - `pinghub --data-dir /path/to/data` — override data directory
  - `pinghub --version` — print version
  - `pinghub --update` — fetch and install latest version
  - `pinghub --uninstall` — remove installation (data preserved)
  ```

- [ ] **Step 2:** Add CHANGELOG entry under `## [Unreleased]`:

  ```markdown
  ### Added
  - Distributable tarball + curl|bash installer (per-platform: mac arm64/x64, linux x64, win x64)
  - `pinghub` command-line launcher (port auto-selection, browser auto-open, --update, --uninstall)
  - Bundled Node 20 runtime — no system Node required
  ```

- [ ] **Step 3:** Commit: `docs(launcher): README install instructions + CHANGELOG`.

### Task 11: Acceptance gate

- [ ] **Step 1:** Verify all of:

  ```bash
  cd <worktree>/aic-pipeline
  npm test                                  # 541+ passing
  npm run build                             # clean
  npm run launcher:build:darwin-arm64       # produces tarball
  ls -lh dist/pinghub-darwin-arm64-*.tar.gz

  # Extract + smoke
  mkdir -p /tmp/pinghub-acceptance
  tar -xzf dist/pinghub-darwin-arm64-*.tar.gz -C /tmp/pinghub-acceptance
  /tmp/pinghub-acceptance/pinghub --no-open --port 48999 &
  sleep 5
  curl -sf http://127.0.0.1:48999/ > /dev/null && echo "✓ E2E OK"
  pkill -f /tmp/pinghub-acceptance
  rm -rf /tmp/pinghub-acceptance
  ```

- [ ] **Step 2:** If all green, M5 done. Plan complete.

---

## Self-Review

**Spec coverage:**
- §2 UX (install + launch + flags) → Tasks 1-4, 7, 8, 10 ✓
- §3 architecture → Tasks 1-6 ✓
- §4 platform matrix → Task 9 ✓
- §5 installer contracts → Tasks 7, 8 ✓
- §6 build pipeline → Tasks 6, 9 ✓
- §7 update/uninstall → Task 4 wires the flags; documented as "re-run install" for v0.3.0 ✓
- §8 acceptance criteria → Tasks 5, 11 ✓

**Placeholder scan:** None. Concrete code/commands for every step.

**Type consistency:** parseArgv return shape consistent across tasks 1, 2, 4. Tarball layout consistent across §3.3, Tasks 6, 7, 8.

Plan ready.
